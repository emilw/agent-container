// Supervises Claude Code in the container:
// - runs `claude auth login` in tmux and relays the link and code over Telegram,
//   both for the first login and whenever the login expires or stops working
// - runs `claude remote-control` in tmux, forwarding its y/n prompts and session link
import { execFile, execFileSync } from "node:child_process";
import { accessSync, constants, copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const CONFIG_DIR = "/config";
const ENV_FILE = `${CONFIG_DIR}/agent.env`;
const TMUX_CONF = "/opt/agent/tmux.conf";
const LOGIN_REPLY_MINUTES = 30;
const HOUR = 3600_000;

const log = (...args) => console.log("[agent]", ...args);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------- config ----------

try {
  accessSync(CONFIG_DIR, constants.W_OK);
} catch {
  log(`${CONFIG_DIR} is not writable by uid ${process.getuid()}. On the NAS run: sudo chown -R ${process.getuid()}:${process.getgid()} <config folder>`);
  await new Promise(() => {});
}

mkdirSync(process.env.CLAUDE_CONFIG_DIR, { recursive: true });
if (!existsSync(ENV_FILE)) {
  copyFileSync("/opt/agent/agent.env.example", ENV_FILE);
  log(`Created ${ENV_FILE}. Fill in TELEGRAM_TOKEN and ALLOWED_USER_IDS, then restart the container.`);
}

// Parse KEY=value lines instead of sourcing, so the file can't run commands.
readFileSync(ENV_FILE, "utf8").split(/\r?\n/).forEach((raw, i) => {
  const line = raw.trim();
  if (!line || line.startsWith("#")) return;
  const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
  if (!m) return log(`Ignoring malformed line ${i + 1} in agent.env`);
  const quoted = m[2].trim().match(/^"(.*)"$|^'(.*)'$/);
  process.env[m[1]] = quoted ? (quoted[1] ?? quoted[2]) : m[2].trim();
});

const cfg = {
  token: process.env.TELEGRAM_TOKEN || "",
  users: (process.env.ALLOWED_USER_IDS || "").split(",").map((s) => s.trim()).filter(Boolean),
  api: (process.env.TELEGRAM_API_BASE || "https://api.telegram.org").replace(/\/$/, ""),
  name: process.env.RC_NAME || "nas",
  rcArgs: (process.env.RC_ARGS || "").split(/\s+/).filter(Boolean),
  checkMs: (Number(process.env.CHECK_INTERVAL_MINUTES) || 30) * 60_000,
  healthPingMs: (Number(process.env.HEALTH_PING_HOURS ?? 6) || 0) * HOUR,
  container: process.env.CONTAINER_NAME || "claude",
};

// Remote Control only works with the claude.ai login; these would take precedence over it.
for (const v of ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN"]) {
  if (process.env[v]) {
    log(`Ignoring ${v}: Remote Control needs the claude.ai login.`);
    delete process.env[v];
  }
}
// Keep the bot token out of the environment Claude's sessions inherit.
delete process.env.TELEGRAM_TOKEN;

const telegram = Boolean(cfg.token && cfg.users.length);

// ---------- state ----------

const state = {
  loginActive: false, // a login flow is running
  loginRequested: false, // /login while logged out and no flow running
  rcRunning: false,
  rcRestart: false,
  rcUrl: null,
};
let pendingReply = null; // { resolve } while something waits for a Telegram reply

// ---------- telegram ----------

async function tg(method, body) {
  const res = await fetch(`${cfg.api}/bot${cfg.token}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(method === "getUpdates" ? 70_000 : 15_000),
  });
  const data = await res.json().catch(() => ({}));
  if (!data.ok) {
    const err = new Error(data.description || `HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return data.result;
}

const send = (chatId, text) =>
  tg("sendMessage", { chat_id: chatId, text, link_preview_options: { is_disabled: true } });

async function notify(text) {
  log(text);
  if (!telegram) return;
  for (const id of cfg.users) {
    await send(id, `[${cfg.name}] ${text}`).catch((e) =>
      log(`Telegram message to ${id} failed: ${e.message} (has that user sent /start to the bot?)`));
  }
}

// Resolves with { text, msg }, "restart" (/login), "loggedIn", or null on timeout.
function waitReply(ms, { resolveWhenLoggedIn = false } = {}) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      clearInterval(poll);
      if (pendingReply?.resolve === finish) pendingReply = null;
      resolve(value);
    };
    pendingReply = { resolve: finish };
    const timer = setTimeout(() => finish(null), ms);
    const poll = resolveWhenLoggedIn
      ? setInterval(async () => { if (await loggedIn()) finish("loggedIn"); }, 10_000)
      : null;
  });
}

const HELP = "/status - login and server state\n/screen - show what Remote Control is showing\n/login - get a new login link\n/restart - restart the Remote Control server";

async function handleMessage(msg) {
  if (!msg?.text || !msg.from) return;
  if (!cfg.users.includes(String(msg.from.id))) {
    log(`Ignoring Telegram message from user ${msg.from.id} (not in ALLOWED_USER_IDS)`);
    return;
  }
  const text = msg.text.trim();
  const cmd = text.startsWith("/") ? text.split(/[\s@]/)[0].toLowerCase() : null;

  if (cmd === "/login") {
    if (state.loginActive) pendingReply?.resolve("restart");
    else if (state.rcRunning) startRenewal("New login requested.");
    else state.loginRequested = true;
    return send(msg.chat.id, "Starting a new login. The link follows shortly.");
  }
  if (cmd === "/restart") {
    state.rcRestart = true;
    return send(msg.chat.id, "Restarting the Remote Control server.");
  }
  if (cmd === "/status") return send(msg.chat.id, await statusText());
  if (cmd === "/screen") {
    const screen = state.rcRunning ? lastLines(capture("rc"), 25) : "";
    return send(msg.chat.id, screen || "Remote Control is not running.");
  }
  if (cmd) return send(msg.chat.id, HELP);

  if (pendingReply) return pendingReply.resolve({ text, msg });
  return send(msg.chat.id, `Nothing is waiting for a reply.\n\n${HELP}`);
}

async function pollTelegram() {
  let offset = 0;
  try {
    // Skip messages sent while the container was down.
    const last = await tg("getUpdates", { offset: -1, timeout: 0 });
    if (last.length) offset = last[0].update_id + 1;
  } catch {}
  for (;;) {
    let updates;
    try {
      updates = await tg("getUpdates", { offset, timeout: 50, allowed_updates: ["message"] });
    } catch (e) {
      if (e.status === 409) log("Another program is reading this bot's messages. Use a separate bot for this container.");
      else if (e.status === 401) log("Telegram rejected TELEGRAM_TOKEN.");
      else log(`Telegram polling failed: ${e.message}`);
      await sleep(e.status === 401 ? 600_000 : 30_000);
      continue;
    }
    for (const u of updates) {
      offset = u.update_id + 1;
      await handleMessage(u.message).catch((e) => log(`Handling Telegram message failed: ${e.message}`));
    }
  }
}

// ---------- tmux ----------

const tmux = (...args) =>
  execFileSync("tmux", ["-f", TMUX_CONF, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

function tmuxKill(name) {
  try { tmux("kill-session", "-t", name); } catch {}
}

function tmuxStart(name, cmd) {
  tmuxKill(name);
  tmux("new-session", "-d", "-s", name, "-x", "250", "-y", "50", "-c", "/workspace", ...cmd);
}

function paneDead(name) {
  try { return tmux("display-message", "-p", "-t", name, "#{pane_dead}").trim() === "1"; } catch { return true; }
}

function capture(name, history = false) {
  try { return tmux("capture-pane", "-p", "-J", "-t", name, ...(history ? ["-S", "-500"] : [])); } catch { return ""; }
}

function typeInto(name, text) {
  tmux("send-keys", "-t", name, "-l", text);
  tmux("send-keys", "-t", name, "Enter");
}

const lastLines = (text, n) => text.split("\n").filter((l) => l.trim()).slice(-n).join("\n");

async function waitFor(fn, ms, interval = 1000) {
  const end = Date.now() + ms;
  for (;;) {
    const value = await fn();
    if (value || Date.now() > end) return value;
    await sleep(interval);
  }
}

// ---------- claude ----------

async function authStatus() {
  try {
    const { stdout } = await execFileAsync("claude", ["auth", "status", "--json"], { timeout: 30_000 });
    return JSON.parse(stdout);
  } catch (e) {
    try { return JSON.parse(e.stdout); } catch { return { loggedIn: false }; }
  }
}

const loggedIn = async () => (await authStatus()).loggedIn === true;

async function statusText() {
  const s = await authStatus();
  const who = s.loggedIn ? `logged in as ${s.email ?? "?"} (${s.subscriptionType ?? s.authMethod})` : "not logged in";
  const rc = state.rcRunning && !paneDead("rc") ? "running" : "stopped";
  const login = state.loginActive ? "\nLogin: waiting for your code" : "";
  return `Claude: ${who}\nRemote Control: ${rc}${login}${state.rcUrl ? `\n${state.rcUrl}` : ""}`;
}

// Runs `claude auth login` and relays it over Telegram until it succeeds or the link times out.
// force: log in even if a login already exists (renewing an expiring or broken login).
// Returns true when a new login was saved.
async function loginFlow(reason, force) {
  state.loginActive = true;
  try {
    let intro = reason;
    while (force || !(await loggedIn())) {
      if (!telegram) {
        log(`${reason} Log in with: docker exec -it ${cfg.container} claude auth login`);
        return false;
      }

      tmuxStart("login", ["claude", "auth", "login", "--claudeai"]);
      const url = await waitFor(() => capture("login").match(/https:\/\/\S*authorize\S*/)?.[0], 30_000);
      if (!url) {
        await notify(`${intro}\n\nCould not start the login:\n${lastLines(capture("login", true), 5)}\n\nSend /login to try again.`);
        return false;
      }

      await notify(`${intro}\n\n1. Open this link and sign in:\n${url}\n\n2. Reply here with the code the page shows.`);
      const answer = await waitReply(LOGIN_REPLY_MINUTES * 60_000, { resolveWhenLoggedIn: !force });
      if (answer === "loggedIn") return true; // logged in another way, e.g. docker exec
      if (answer === "restart") { force = true; intro = "New login requested."; continue; }
      if (!answer) {
        await notify("The login link expired. Send /login for a new one.");
        return false;
      }

      // The code is single-use, but don't leave it lying around in the chat.
      tg("deleteMessage", { chat_id: answer.msg.chat.id, message_id: answer.msg.message_id }).catch(() => {});
      typeInto("login", answer.text);
      await waitFor(() => paneDead("login") || /Login (successful|failed)/i.test(capture("login")), 60_000);
      const out = capture("login", true);
      if (/Login successful/i.test(out) && (await loggedIn())) {
        await notify("Logged in to Claude.");
        return true;
      }
      intro = `${out.match(/Login failed[^\n]*/)?.[0] ?? lastLines(out, 3)}\n\nHere is a new link.`;
    }
    return true;
  } finally {
    tmuxKill("login");
    state.loginActive = false;
  }
}

// Renews the login while Remote Control keeps running, then restarts it on the new login.
function startRenewal(reason) {
  if (state.loginActive) return;
  loginFlow(reason, true)
    .then((ok) => {
      if (ok) {
        healthProblem = false;
        state.rcRestart = true;
      }
    })
    .catch((e) => log(`Login flow failed: ${e.message}`));
}

// Remote Control only starts in a folder whose trust question was answered.
// Claude Code records that answer per folder in .claude.json.
const CLAUDE_JSON = `${process.env.CLAUDE_CONFIG_DIR}/.claude.json`;
const WORKSPACE = "/workspace";

function readClaudeJson() {
  try { return JSON.parse(readFileSync(CLAUDE_JSON, "utf8")); } catch { return {}; }
}

const workspaceTrusted = () => readClaudeJson().projects?.[WORKSPACE]?.hasTrustDialogAccepted === true;

function trustWorkspace() {
  const config = readClaudeJson();
  config.projects ??= {};
  config.projects[WORKSPACE] = { ...config.projects[WORKSPACE], hasTrustDialogAccepted: true };
  writeFileSync(`${CLAUDE_JSON}.tmp`, JSON.stringify(config, null, 2));
  renameSync(`${CLAUDE_JSON}.tmp`, CLAUDE_JSON);
}

// Returns once /workspace is trusted.
async function ensureWorkspaceTrusted() {
  while (!workspaceTrusted()) {
    if (!telegram) {
      log(`Remote Control needs ${WORKSPACE} to be trusted. Run: docker exec -it ${cfg.container} claude  (then accept the trust question and exit)`);
      await waitFor(workspaceTrusted, Infinity, 10_000);
      return;
    }
    await notify(
      `Remote Control needs you to trust ${WORKSPACE}, your mounted repos folder. ` +
      "Claude sessions can then read and edit files and run commands there.\n\nReply yes to trust it.");
    const answer = await waitReply(7 * 24 * HOUR);
    if (answer?.text && /^y(es)?$/i.test(answer.text)) {
      trustWorkspace();
      await notify(`${WORKSPACE} is trusted. Starting Remote Control.`);
      return;
    }
    if (answer?.text) await notify("Not trusted, so Remote Control can't start. I'll ask again.");
  }
}

async function runRemoteControl() {
  state.rcRunning = true;
  state.rcUrl = null;
  tmuxStart("rc", ["claude", "remote-control", "--name", cfg.name, ...cfg.rcArgs]);
  log("Remote Control server starting.");
  let started = Date.now();
  let asked = false;
  let stuckReported = false;
  let stuckReply = null;
  let expiryHandled = false;

  try {
    for (;;) {
      await sleep(2000);
      if (state.rcRestart) return;

      if (paneDead("rc")) {
        await notify(`Remote Control server stopped:\n${lastLines(capture("rc", true), 8)}\n\nRestarting in 60 seconds.`);
        return;
      }

      const screen = capture("rc");
      const history = capture("rc", true);

      if (!state.rcUrl) {
        const url = history.match(/https:\/\/claude\.ai\/code\S*/)?.[0];
        if (url) {
          state.rcUrl = url;
          if (pendingReply && pendingReply === stuckReply) pendingReply.resolve(null);
          await notify(`Remote Control is running. Open it here:\n${url}`);
        }
      }

      // No link after 30s means something on screen is waiting. Show it and relay the answer.
      if (!state.rcUrl && !asked && !stuckReported && !state.loginActive && Date.now() - started > 30_000) {
        stuckReported = true;
        await notify(
          `Remote Control hasn't shown a session link yet. Its screen:\n\n${lastLines(screen, 15)}\n\n` +
          "Reply to type an answer into it (e.g. 1, y or enter), or send /screen to look again.");
        waitReply(24 * HOUR).then((a) => {
          if (!a?.text || !state.rcRunning || paneDead("rc")) return;
          if (/^enter$/i.test(a.text)) tmux("send-keys", "-t", "rc", "Enter");
          else typeInto("rc", a.text);
          stuckReported = false; // report again if it still doesn't start
          started = Date.now();
        });
        stuckReply = pendingReply;
      }

      // Claude Code warns a few days before the login expires, and says so once it has.
      const expiry = history.match(/login expires in[^\n·]*|login expired[^\n·]*|log in again[^\n·]*/i);
      if (expiry && !expiryHandled) {
        expiryHandled = true;
        startRenewal(`Claude says: "${expiry[0].trim()}"\nRenew the login now to keep Remote Control working.`);
      }

      const prompt = /\(y\/n\)/i.test(lastLines(screen, 6));
      if (prompt && !asked && !state.loginActive) {
        asked = true;
        await notify(`Remote Control is asking:\n\n${lastLines(screen, 10)}\n\nReply y or n.`);
        waitReply(24 * HOUR).then((a) => {
          if (a?.text && state.rcRunning && !paneDead("rc")) typeInto("rc", a.text.trim().charAt(0).toLowerCase());
        });
      } else if (!prompt) {
        asked = false;
      }
    }
  } finally {
    if (!state.loginActive) pendingReply?.resolve(null);
    tmuxKill("rc");
    state.rcRunning = false;
  }
}

// ---------- watchdog ----------

let lastPing = 0;
let healthProblem = false;
const AUTH_ERROR = /log ?in|expired|auth|unauthori[sz]ed|oauth|token|\b401\b|\b403\b/i;

async function watchdog() {
  if (!state.rcRunning || state.loginActive) return;
  if (!(await loggedIn())) {
    await notify("Claude is logged out. Remote Control is stopped until you log in again.");
    state.rcRestart = true; // the main loop runs the login flow
    return;
  }
  if (!cfg.healthPingMs || Date.now() - lastPing < cfg.healthPingMs) return;
  lastPing = Date.now();
  try {
    await execFileAsync("claude", ["-p", "--model", "haiku", "Reply with just OK"], { cwd: "/tmp", timeout: 180_000 });
    if (healthProblem) await notify("Claude health check passes again.");
    healthProblem = false;
  } catch (e) {
    const out = `${e.stdout ?? ""}${e.stderr ?? ""}`.trim().slice(-300) || e.message;
    if (AUTH_ERROR.test(out)) {
      startRenewal(`Claude's login stopped working:\n${out}`);
    } else if (!healthProblem) {
      await notify(`Claude health check failed:\n${out}\n\nSend /login if this looks like a login problem.`);
    }
    healthProblem = true;
  }
}

// ---------- main ----------

for (const sig of ["SIGTERM", "SIGINT"]) {
  process.on(sig, () => {
    try { tmux("kill-server"); } catch {}
    process.exit(0);
  });
}

if (telegram) pollTelegram();
else log("Telegram is not configured (TELEGRAM_TOKEN / ALLOWED_USER_IDS in agent.env); messages go to the container log only.");

setInterval(() => watchdog().catch((e) => log(`Watchdog failed: ${e.message}`)), cfg.checkMs);

for (;;) {
  await waitFor(() => !state.loginActive, Infinity);
  if (!(await loggedIn())) {
    const ok = await loginFlow("Claude needs a login.", false);
    if (!ok) {
      // Wait for /login, or a login made another way (docker exec).
      await waitFor(async () => {
        if (state.loginRequested) {
          state.loginRequested = false;
          return true;
        }
        return loggedIn();
      }, Infinity, 10_000);
      continue;
    }
  }
  await ensureWorkspaceTrusted();
  await runRemoteControl();
  if (!state.rcRestart) await waitFor(() => state.rcRestart, 60_000);
  state.rcRestart = false;
}

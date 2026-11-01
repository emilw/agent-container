// Supervises Claude Code in the container:
// - runs `claude auth login` in tmux and relays the link and code over Telegram,
//   both for the first login and whenever the login expires or stops working
// - runs `claude remote-control` in tmux, forwarding its y/n prompts and session link
// - serves a tools API on localhost for programs in /workspace (Telegram notify, config values),
//   and the same tools as an MCP server for Claude sessions
import { execFile, execFileSync } from "node:child_process";
import { accessSync, constants, copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { promisify } from "node:util";
import { addr, sendMail } from "./smtp.mjs";

const execFileAsync = promisify(execFile);
const CONFIG_DIR = "/config";
const ENV_FILE = `${CONFIG_DIR}/agent.env`;
// agent.env is the one central config; the tools API serves all of it except these.
const HIDDEN_CONFIG_KEYS = new Set(["TELEGRAM_TOKEN", "GH_TOKEN", "GITHUB_TOKEN", "SMTP_PASS"]);
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
function parseEnvFile(path) {
  const values = {};
  readFileSync(path, "utf8").split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim();
    if (!line || line.startsWith("#")) return;
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_.-]*)=(.*)$/);
    if (!m) return log(`Ignoring malformed line ${i + 1} in ${path}`);
    const quoted = m[2].trim().match(/^"(.*)"$|^'(.*)'$/);
    values[m[1]] = quoted ? (quoted[1] ?? quoted[2]) : m[2].trim();
  });
  return values;
}

Object.assign(process.env, parseEnvFile(ENV_FILE));

const cfg = {
  token: process.env.TELEGRAM_TOKEN || "",
  users: (process.env.ALLOWED_USER_IDS || "").split(",").map((s) => s.trim()).filter(Boolean),
  api: (process.env.TELEGRAM_API_BASE || "https://api.telegram.org").replace(/\/$/, ""),
  name: process.env.RC_NAME || "nas",
  rcArgs: (process.env.RC_ARGS || "").split(/\s+/).filter(Boolean),
  checkMs: (Number(process.env.CHECK_INTERVAL_MINUTES) || 30) * 60_000,
  healthPingMs: (Number(process.env.HEALTH_PING_HOURS ?? 6) || 0) * HOUR,
  container: process.env.CONTAINER_NAME || "claude",
  toolsPort: Number(process.env.TOOLS_PORT) || 7777,
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
process.env.AGENT_TOOLS_URL = `http://127.0.0.1:${cfg.toolsPort}`;

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

// ---------- tools API ----------
// Localhost only, for everything running in the container. One registry, two front doors:
// every feature is an entry in API below with a REST route (for programs in /workspace)
// and optionally an MCP tool (for Claude sessions). REST routing, the MCP tool list and
// /openapi.json are all generated from it, so no feature exists in MCP without a REST
// endpoint. Add new features as API entries.

const NOTIFY_LIMIT_PER_MINUTE = 20;
let notifyTimes = [];

async function toolsNotify({ text, title }) {
  if (!telegram) return [503, { ok: false, error: "Telegram is not configured in agent.env" }];

  const now = Date.now();
  notifyTimes = notifyTimes.filter((t) => now - t < 60_000);
  if (notifyTimes.length >= NOTIFY_LIMIT_PER_MINUTE) {
    return [429, { ok: false, error: `More than ${NOTIFY_LIMIT_PER_MINUTE} notifications a minute` }];
  }
  notifyTimes.push(now);

  const heading = title?.trim() ? `${title.trim()}\n` : "";
  const message = `[${cfg.name}] ${heading}${text.trim()}`.slice(0, 4096);
  let sent = 0;
  for (const id of cfg.users) {
    try {
      await send(id, message);
      sent++;
    } catch (e) {
      log(`Tools notify to ${id} failed: ${e.message}`);
    }
  }
  return sent ? [200, { ok: true, sent }] : [502, { ok: false, error: "Telegram did not accept the message" }];
}

function toolsConfig(key) {
  // Read the file on every request, so edits apply without a restart.
  const values = Object.fromEntries(
    Object.entries(parseEnvFile(ENV_FILE)).filter(([k]) => !HIDDEN_CONFIG_KEYS.has(k)));
  if (key === undefined) return [200, { ok: true, keys: Object.keys(values) }];
  if (HIDDEN_CONFIG_KEYS.has(key)) return [403, { ok: false, error: `${key} is not available through the tools API` }];
  return key in values
    ? [200, { ok: true, key, value: values[key] }]
    : [404, { ok: false, error: `No ${key} in agent.env` }];
}

const EMAIL_LIMIT_PER_HOUR = 30;
let emailTimes = [];
const splitList = (s) => (s ?? "").split(",").map((a) => a.trim()).filter(Boolean);

async function toolsEmail({ subject, text, html, to }) {
  // Read the SMTP settings on every send, so edits to agent.env apply without a restart.
  const env = parseEnvFile(ENV_FILE);
  const missing = ["SMTP_HOST", "MAIL_FROM", "MAIL_TO"].filter((k) => !env[k]);
  if (missing.length) return [503, { ok: false, error: `Email is not configured: add ${missing.join(", ")} to agent.env` }];

  // Recipients always come from agent.env, so mail only goes to addresses the owner listed.
  let recipients = splitList(env.MAIL_TO);
  if (to !== undefined) {
    const allowed = new Map([...recipients, ...splitList(env.MAIL_ALLOWED_TO)].map((a) => [addr(a).toLowerCase(), a]));
    const asked = splitList(to);
    const unknown = asked.filter((a) => !allowed.has(addr(a).toLowerCase()));
    if (!asked.length) return [400, { ok: false, error: "to is empty" }];
    if (unknown.length) {
      return [403, { ok: false, error: `Not an allowed recipient: ${unknown.join(", ")}. The owner can add it to MAIL_ALLOWED_TO in agent.env.` }];
    }
    recipients = asked.map((a) => allowed.get(addr(a).toLowerCase()));
  }

  const now = Date.now();
  emailTimes = emailTimes.filter((t) => now - t < HOUR);
  if (emailTimes.length >= EMAIL_LIMIT_PER_HOUR) {
    return [429, { ok: false, error: `More than ${EMAIL_LIMIT_PER_HOUR} emails an hour` }];
  }
  emailTimes.push(now);

  try {
    await sendMail(
      { host: env.SMTP_HOST, port: Number(env.SMTP_PORT) || 587, user: env.SMTP_USER, pass: env.SMTP_PASS, helo: "agent-container" },
      { from: env.MAIL_FROM, to: recipients, subject: subject.trim(), text, html: html || undefined },
    );
  } catch (e) {
    log(`Email failed: ${e.message}`);
    return [502, { ok: false, error: `Sending failed: ${e.message}` }];
  }
  return [200, { ok: true, to: recipients.map(addr) }];
}

// Each entry: id (OpenAPI operationId and MCP tool name), method, path ({name} segments are
// path parameters), summary, input (JSON Schema properties; path parameters plus the JSON
// body), required, response (properties returned besides ok), run(input) -> [status, body],
// and mcp ({ description, result(body) -> text }) to also expose it as an MCP tool.
const API = [
  {
    id: "health",
    method: "GET",
    path: "/health",
    summary: "Check the service is up, and whether Telegram is configured.",
    response: { telegram: { type: "boolean" } },
    run: () => [200, { ok: true, telegram }],
  },
  {
    id: "notify",
    method: "POST",
    path: "/notify",
    summary: `Send a Telegram message to the owner. At most ${NOTIFY_LIMIT_PER_MINUTE} a minute.`,
    input: {
      text: { type: "string", description: "The message" },
      title: { type: "string", description: "Optional first line, such as the program or task name" },
    },
    required: ["text"],
    response: { sent: { type: "integer", description: "Number of Telegram users the message reached" } },
    run: toolsNotify,
    mcp: {
      description: `Send a Telegram message to the owner's phone. For results or events the owner asked to hear about, not progress or debugging. At most ${NOTIFY_LIMIT_PER_MINUTE} a minute.`,
      result: (body) => `Sent to ${body.sent} Telegram user(s).`,
    },
  },
  {
    id: "email",
    method: "POST",
    path: "/email",
    summary: `Send an email from the owner's configured mail account. Goes to MAIL_TO; 'to' may only name addresses in MAIL_TO or MAIL_ALLOWED_TO. At most ${EMAIL_LIMIT_PER_HOUR} an hour.`,
    input: {
      subject: { type: "string", description: "Subject line" },
      text: { type: "string", description: "Plain-text body. Also shown by mail apps that don't display HTML." },
      html: { type: "string", description: "Optional HTML body" },
      to: { type: "string", description: "Optional comma-separated recipients; each must be in MAIL_TO or MAIL_ALLOWED_TO. Defaults to MAIL_TO." },
    },
    required: ["subject", "text"],
    response: { to: { type: "array", items: { type: "string" }, description: "Addresses the mail was sent to" } },
    run: toolsEmail,
    mcp: {
      description: "Send the owner an email. Use it for longer content the owner wants by mail, such as reports, digests or summaries; use notify for short alerts. Goes to the owner unless 'to' names an address the owner allowed.",
      result: (body) => `Sent to ${body.to.join(", ")}.`,
    },
  },
  {
    id: "list_config",
    method: "GET",
    path: "/config",
    summary: "List the key names in the owner's central config (agent.env). Tokens are left out.",
    response: { keys: { type: "array", items: { type: "string" } } },
    run: () => toolsConfig(),
    mcp: {
      description: "List the key names in the owner's central config (agent.env). Read values with get_config.",
      result: (body) => body.keys.join("\n") || "(agent.env has no keys you can read)",
    },
  },
  {
    id: "get_config",
    method: "GET",
    path: "/config/{key}",
    summary: "Read one value from agent.env. 404 if the key doesn't exist, 403 for tokens.",
    input: { key: { type: "string", description: "Key name, e.g. EXAMPLE_API_URL" } },
    required: ["key"],
    response: { key: { type: "string" }, value: { type: "string" } },
    run: ({ key }) => toolsConfig(key),
    mcp: {
      description: "Read one value from the owner's central config (agent.env). If the key doesn't exist, tell the owner which key to add instead of guessing a value.",
      result: (body) => body.value,
    },
  },
];

for (const route of API) {
  route.params = [...route.path.matchAll(/\{(\w+)\}/g)].map((m) => m[1]);
  route.pattern = new RegExp(`^${route.path.replace(/\{\w+\}/g, "([^/]+)")}/?$`);
}

// Shared by REST and MCP, so both get the same input checks.
async function callRoute(route, input) {
  for (const name of route.required ?? []) {
    if (typeof input[name] !== "string" || !input[name].trim()) {
      return [400, { ok: false, error: `${name} is required` }];
    }
  }
  for (const [name, schema] of Object.entries(route.input ?? {})) {
    if (input[name] !== undefined && schema.type === "string" && typeof input[name] !== "string") {
      return [400, { ok: false, error: `${name} must be a string` }];
    }
  }
  return route.run(input);
}

function apiIndex() {
  return {
    ok: true,
    openapi: "/openapi.json",
    mcp: "/mcp",
    endpoints: API.map((r) => ({ method: r.method, path: r.path, summary: r.summary, mcpTool: r.mcp ? r.id : null })),
  };
}

function openApiSpec() {
  const json = (schema) => ({ "application/json": { schema } });
  const error = { type: "object", properties: { ok: { const: false }, error: { type: "string" } } };
  const paths = {};
  for (const r of API) {
    const bodyFields = Object.keys(r.input ?? {}).filter((k) => !r.params.includes(k));
    const op = {
      operationId: r.id,
      summary: r.summary,
      ...(r.mcp && { "x-mcp-tool": r.id }),
      ...(r.params.length && {
        parameters: r.params.map((name) => ({ name, in: "path", required: true, schema: r.input[name] })),
      }),
      ...(bodyFields.length && {
        requestBody: {
          required: true,
          content: json({
            type: "object",
            properties: Object.fromEntries(bodyFields.map((k) => [k, r.input[k]])),
            required: (r.required ?? []).filter((k) => bodyFields.includes(k)),
          }),
        },
      }),
      responses: {
        200: { description: "Success", content: json({ type: "object", properties: { ok: { const: true }, ...r.response } }) },
        default: { description: "Error", content: json(error) },
      },
    };
    (paths[r.path] ??= {})[r.method.toLowerCase()] = op;
  }
  return {
    openapi: "3.1.0",
    info: {
      title: "agent-tools",
      version: "1.0.0",
      description: "Tools service of the agent container. Every endpoint marked x-mcp-tool is also an MCP tool at /mcp.",
    },
    servers: [{ url: `http://127.0.0.1:${cfg.toolsPort}` }],
    paths,
  };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      // Room for an HTML email body
      if (body.length > 2 * 1024 * 1024) reject(Object.assign(new Error("Body too large"), { status: 413 }));
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

// ---------- MCP ----------
// The API's mcp entries as an MCP server (streamable HTTP, stateless JSON responses) at
// /mcp. Registered at user scope, so every Claude session in the container gets it.

const MCP_NAME = "agent-tools";

const MCP_INSTRUCTIONS = `Tools provided by the container this session runs in, on the owner's NAS.
- notify: send the owner a Telegram message. Use it when the owner asked to be told about something (a result, a finished long task, a failure in something they rely on). Don't use it for progress updates or debugging, and don't send the same message twice.
- email: send the owner an email, for longer content they want by mail (reports, digests, summaries). Use notify for short alerts. Only addresses the owner listed can receive mail.
- get_config / list_config: read values from the owner's central config (agent.env). Use these for URLs, account names and other settings instead of asking the owner or hardcoding values. If a needed key is missing, tell the owner the exact key name to add; never invent a value. Bot and GitHub tokens are never returned.
Every tool is also a REST endpoint at $AGENT_TOOLS_URL, described by $AGENT_TOOLS_URL/openapi.json. Programs you write in /workspace can't use MCP, so they must call those endpoints instead.`;

const mcpTools = () =>
  API.filter((r) => r.mcp).map((r) => ({
    name: r.id,
    description: r.mcp.description,
    inputSchema: { type: "object", properties: r.input ?? {}, required: r.required ?? [] },
  }));

async function mcpCallTool(name, args) {
  const route = API.find((r) => r.mcp && r.id === name);
  if (!route) return null;
  const [, body] = await callRoute(route, args && typeof args === "object" ? args : {});
  return { content: [{ type: "text", text: body.ok ? route.mcp.result(body) : body.error }], isError: !body.ok };
}

async function handleMcp(raw) {
  const rpcError = (id, code, message) => ({ jsonrpc: "2.0", id, error: { code, message } });
  let msg;
  try { msg = JSON.parse(raw); } catch { return [400, rpcError(null, -32700, "Parse error")]; }
  if (!msg || typeof msg !== "object" || Array.isArray(msg)) return [400, rpcError(null, -32600, "Invalid request")];

  const { id, method, params } = msg;
  if (id === undefined || id === null) return [202, null]; // a notification, e.g. notifications/initialized
  const result = (value) => [200, { jsonrpc: "2.0", id, result: value }];

  switch (method) {
    case "initialize":
      return result({
        protocolVersion: params?.protocolVersion ?? "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: MCP_NAME, version: "1.0.0" },
        instructions: MCP_INSTRUCTIONS,
      });
    case "ping":
      return result({});
    case "tools/list":
      return result({ tools: mcpTools() });
    case "tools/call": {
      const called = await mcpCallTool(params?.name, params?.arguments);
      return called ? result(called) : [200, rpcError(id, -32602, `Unknown tool: ${params?.name}`)];
    }
    default:
      return [200, rpcError(id, -32601, `Method not found: ${method}`)];
  }
}

// Add (or fix) the user-scope MCP entry so every Claude session in the container connects.
async function registerMcpServer() {
  const want = { type: "http", url: `http://127.0.0.1:${cfg.toolsPort}/mcp` };
  const have = readClaudeJson().mcpServers?.[MCP_NAME];
  if (have?.type === want.type && have?.url === want.url) return;
  try {
    if (have) await execFileAsync("claude", ["mcp", "remove", "--scope", "user", MCP_NAME], { timeout: 30_000 });
    await execFileAsync("claude", ["mcp", "add-json", "--scope", "user", MCP_NAME, JSON.stringify(want)], { timeout: 30_000 });
    log(`Registered the ${MCP_NAME} MCP server for Claude sessions.`);
  } catch (e) {
    log(`Could not register the ${MCP_NAME} MCP server: ${(e.stderr || e.message).trim()}`);
  }
}

// ---------- HTTP server ----------

async function handleTools(req) {
  const { pathname } = new URL(req.url, "http://localhost");

  if (pathname === "/mcp") {
    return req.method === "POST"
      ? handleMcp(await readBody(req))
      : [405, { ok: false, error: "MCP clients POST JSON-RPC to /mcp" }];
  }
  if (req.method === "GET" && pathname === "/") return [200, apiIndex()];
  if (req.method === "GET" && pathname === "/openapi.json") return [200, openApiSpec()];

  for (const route of API) {
    const m = route.method === req.method && pathname.match(route.pattern);
    if (!m) continue;
    let input = {};
    if (req.method === "POST") {
      const raw = await readBody(req);
      try { input = raw ? JSON.parse(raw) : {}; } catch { input = null; }
      if (!input || typeof input !== "object" || Array.isArray(input)) {
        return [400, { ok: false, error: "The body must be a JSON object" }];
      }
    }
    route.params.forEach((name, i) => { input[name] = decodeURIComponent(m[i + 1]); });
    return callRoute(route, input);
  }
  return [404, { ok: false, error: "Unknown endpoint. GET / lists the endpoints, GET /openapi.json describes them." }];
}

function startToolsServer() {
  const server = createServer(async (req, res) => {
    let status, body;
    try {
      [status, body] = await handleTools(req);
    } catch (e) {
      [status, body] = [e.status || 500, { ok: false, error: e.message }];
    }
    if (body === null) return res.writeHead(status).end();
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  });
  server.on("error", (e) => log(`Tools API failed: ${e.message}`));
  server.listen(cfg.toolsPort, "127.0.0.1", () => log(`Tools API on http://127.0.0.1:${cfg.toolsPort}`));
}

// ---------- main ----------

for (const sig of ["SIGTERM", "SIGINT"]) {
  process.on(sig, () => {
    try { tmux("kill-server"); } catch {}
    process.exit(0);
  });
}

startToolsServer();
await registerMcpServer();
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

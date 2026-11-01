// Minimal SMTP client, no dependencies. Ported from myNewsFeed's src/smtp.js:
// STARTTLS (or implicit TLS on port 465) + AUTH LOGIN, one message per connection.
import net from "node:net";
import tls from "node:tls";
import { randomUUID } from "node:crypto";

function session(socket) {
  let buf = "";
  let waiting = null;
  const onData = (chunk) => {
    buf += chunk.toString("utf8");
    const lines = buf.split("\r\n");
    for (let i = 0; i < lines.length - 1; i++) {
      // The last line of a reply is "NNN text"; continuation lines are "NNN-text".
      if (/^\d{3} /.test(lines[i]) && waiting) {
        const reply = lines.slice(0, i + 1).join("\n");
        buf = lines.slice(i + 1).join("\r\n");
        const w = waiting;
        waiting = null;
        return w(reply);
      }
    }
  };
  socket.on("data", onData);
  const read = () => new Promise((resolve, reject) => {
    waiting = resolve;
    socket.once("error", reject);
    onData("");
  });
  return {
    read,
    detach: () => socket.off("data", onData),
    async cmd(line, expect, display = line) {
      socket.write(line + "\r\n");
      const reply = await read();
      if (!reply.startsWith(String(expect))) throw new Error(`SMTP "${display}" -> ${reply}`);
      return reply;
    },
  };
}

const b64 = (s) => Buffer.from(s, "utf8").toString("base64");
const wrap = (s) => s.replace(/.{1,76}/g, "$&\r\n");
export const addr = (s) => (s.match(/<([^>]+)>/) || [, s])[1].trim();

function part(type, content) {
  return [`Content-Type: ${type}; charset=utf-8`, "Content-Transfer-Encoding: base64", "", wrap(b64(content))];
}

function buildMessage({ from, to, subject, text, html }) {
  const domain = addr(from).split("@")[1];
  const headers = [
    `From: ${from}`,
    `To: ${to.join(", ")}`,
    `Subject: =?UTF-8?B?${b64(subject)}?=`,
    `Date: ${new Date().toUTCString().replace("GMT", "+0000")}`,
    `Message-ID: <${randomUUID()}@${domain}>`,
    "MIME-Version: 1.0",
  ];
  if (!html) return [...headers, ...part("text/plain", text), ""].join("\r\n");
  const boundary = "b" + randomUUID();
  return [
    ...headers,
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    "",
    `--${boundary}`,
    ...part("text/plain", text),
    `--${boundary}`,
    ...part("text/html", html),
    `--${boundary}--`,
    "",
  ].join("\r\n");
}

function connected(socket, event) {
  return new Promise((resolve, reject) => {
    socket.once(event, resolve);
    socket.once("error", reject);
  });
}

// server: { host, port, user?, pass?, helo }. message: { from, to: [addresses], subject, text, html? }.
// The caller must pass header-safe values: no CR or LF in from or to.
export async function sendMail({ host, port, user, pass, helo }, msg) {
  const implicitTls = port === 465;
  let sock = implicitTls ? tls.connect({ host, port, servername: host }) : net.connect({ host, port });
  await connected(sock, implicitTls ? "secureConnect" : "connect");
  sock.setTimeout(30_000, () => sock.destroy(new Error("SMTP timeout")));

  let s = session(sock);
  const greeting = await s.read();
  if (!greeting.startsWith("220")) throw new Error(`SMTP greeting: ${greeting}`);
  await s.cmd(`EHLO ${helo}`, 250);
  if (!implicitTls) {
    await s.cmd("STARTTLS", 220);
    s.detach();
    sock = tls.connect({ socket: sock, servername: host });
    await connected(sock, "secureConnect");
    s = session(sock);
    await s.cmd(`EHLO ${helo}`, 250);
  }
  if (user) {
    await s.cmd("AUTH LOGIN", 334);
    await s.cmd(b64(user), 334, "<user>");
    await s.cmd(b64(pass ?? ""), 235, "<password>");
  }
  await s.cmd(`MAIL FROM:<${addr(msg.from)}>`, 250);
  for (const r of msg.to) await s.cmd(`RCPT TO:<${addr(r)}>`, 250);
  await s.cmd("DATA", 354);
  const body = buildMessage(msg).replace(/\r\n\./g, "\r\n..");
  await s.cmd(body + "\r\n.", 250, "<message>");
  await s.cmd("QUIT", 221).catch(() => {});
  sock.end();
}

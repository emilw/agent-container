# agent-container

Claude Code running as a Remote Control server, for a NAS. Sessions show up in
claude.ai/code, the Claude mobile app and Claude Desktop. Logging in, and renewing
the login when it expires, happens over Telegram: no SSH needed.

The image is built by GitHub Actions and published to
`ghcr.io/emilw/agent-container` (amd64 + arm64) on every push to `main` and weekly.

## Folders

| Container path | Mount | Holds |
| --- | --- | --- |
| `/config` | an empty folder on the NAS | `agent.env` (the central config: container settings and values for your own programs, created on first start from [agent.env.example](agent.env.example)) and `claude/` (the Claude login, settings and history) |
| `/workspace` | your repos folder | the code Claude works on; its `AGENTS.md` holds the main instructions |

The container runs as uid 1000, so both folders must be writable by it. `/config` is
private: anyone with a copy of `config/claude/` can use your Claude account.

## Setup

1. Create a Telegram bot with @BotFather, just for this container, and send it `/start`.
   Get your user ID from @userinfobot.
2. On the NAS, copy `docker-compose.yml`, set the `/workspace` path, then:
   ```bash
   mkdir -p config && sudo chown -R 1000:1000 config
   docker compose up -d
   ```
3. Fill in `TELEGRAM_TOKEN` and `ALLOWED_USER_IDS` in `config/agent.env`, then:
   ```bash
   docker compose restart
   ```
4. The bot sends you a login link. Open it on your phone, sign in with your claude.ai
   account, and reply to the bot with the code the page shows.
5. The first time, the bot asks you to trust `/workspace` (reply `yes`) and forwards
   Remote Control's `Enable Remote Control? (y/n)` question (reply `y`).
6. The bot sends you the session link. Open it, or find **nas** under **Code** in the
   Claude app or at claude.ai/code.

If no link arrives within 30 seconds, the bot sends you Remote Control's screen instead
and types your reply into it.

## Telegram

The bot sends a new login link, and restarts Remote Control on the new login once you
reply with the code, when:

- there is no login (Remote Control stays stopped until you log in)
- Claude Code warns the login expires in a few days, or says it has expired
  (Remote Control keeps running while it waits for you)
- the health check fails with a login error (every `HEALTH_PING_HOURS`)
- you send `/login`

Commands: `/status`, `/screen` (what Remote Control is showing), `/login`, `/restart`.
Only users in `ALLOWED_USER_IDS` are listened to, and the bot deletes your code message
after using it.

Without Telegram configured, log in with `docker exec -it claude claude auth login`
and watch `docker logs claude`.

## Tools API

Programs you build in `/workspace` can use a small API on `http://127.0.0.1:7777`
(`$AGENT_TOOLS_URL`), reachable only from inside the container:

- `POST /notify` with `{"text": "...", "title": "..."}` sends you a Telegram message (max 20 a minute)
- `GET /config/<KEY>` returns a value from `config/agent.env`; `GET /config` lists the keys

Every key in `agent.env` is served except `TELEGRAM_TOKEN`. Value changes apply
immediately; the container's own settings still need a restart. Shell scripts can use `agent-tools notify "..."` and
`agent-tools config KEY`. [AGENTS.MD](AGENTS.MD) tells Claude how to use all of this.

## Instructions for Claude

[AGENTS.MD](AGENTS.MD) is installed as `/etc/claude-code/CLAUDE.md`, so every
session in the container loads it. It points Claude at `/workspace/AGENTS.md`.

## Troubleshooting

See what Remote Control is showing (detach with `Ctrl+B` then `D`):

```bash
docker exec -it claude tmux -f /opt/agent/tmux.conf attach -t rc
```

## Updating

```bash
docker compose pull && docker compose up -d
```

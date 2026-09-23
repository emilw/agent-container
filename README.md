# agent-container

Claude Code running as a Remote Control server, for a NAS. Sessions show up in
claude.ai/code, the Claude mobile app and Claude Desktop.

The image is built by GitHub Actions and published to
`ghcr.io/emilw/agent-container` (amd64 + arm64) on every push to `main` and weekly.

## Config folder

Everything the container keeps lives in one folder on the NAS, mounted at `/config`:

| Path | What |
| --- | --- |
| `config/agent.env` | Your settings: Telegram token, user IDs, Remote Control flags. Created from [agent.env.example](agent.env.example) on first start. |
| `config/claude/` | Claude login, settings and session history (`CLAUDE_CONFIG_DIR`). |

Both are private. Keep them out of git and out of shared backups.

## Telegram alerts

With `TELEGRAM_TOKEN` and `ALLOWED_USER_IDS` set, the container messages you when:

- it starts and there is no Claude login (with the command to run)
- the login disappears, or the daily health check fails (`HEALTH_PING=1`), which is how an expired login shows up
- the Remote Control server exits or starts

Each user in `ALLOWED_USER_IDS` must send `/start` to the bot once before it can message them.

## First-time setup on the NAS

Copy `docker-compose.yml` to the NAS and set the `/workspace` volume path. The
container runs as uid 1000, so the mounted folders must be writable by it.

```bash
mkdir -p config && sudo chown -R 1000:1000 config
docker compose up -d
```

The first start creates `config/agent.env`. Fill in the Telegram values, then:

```bash
docker compose restart
```

The container waits for a login (and tells you on Telegram). Log in:

```bash
docker exec -it claude claude auth login
```

Open the URL it prints, sign in with your claude.ai account, and paste the code
shown in the browser back into the terminal. Within 30 seconds the container starts
Remote Control. The first time only, accept its prompt:

```bash
docker attach claude
```

Answer `y`, then detach with `Ctrl+P` `Ctrl+Q` (not `Ctrl+C`, which stops the server).

## Updating

```bash
docker compose pull && docker compose up -d
```

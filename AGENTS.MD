# AGENTS.md
You are an agent proxy for working with Claude remote in a container. This file just bootstraps the flow, read ## Main instructions for more details.
 
## Main instructions
Always load the AGENTS.md file in /workspace, this is mounted to the main workspace folder where further instructions are carried out.

## GitHub
The GitHub CLI (`gh`) is installed, and `git` uses it for github.com credentials, so `git push` and `gh pr create` work once `gh` is logged in. The login is stored in `/config/gh` and survives restarts and image updates.

- Check with `gh auth status` before the first GitHub operation in a session.
- If it is not logged in, start the device login in the background, because it waits until the owner approves:
  `gh auth login --hostname github.com --git-protocol https --web`
  It prints a one-time code and the URL https://github.com/login/device. Show both to the owner and wait for them to approve. The code expires after 15 minutes.
- If `GH_TOKEN` is set, `gh` uses that token and no login is needed.
- Never print or commit tokens.

## Tools service
The container runs a tools service with two front doors over the same functions:

- **You (Claude) use the `agent-tools` MCP tools:** `notify`, `get_config` and `list_config`. They are connected in every session automatically. Use them directly instead of calling the HTTP API with curl.
- **Programs you build in /workspace use the HTTP API below.** They can't use MCP. Use it instead of adding your own Telegram code or hardcoding configuration values.

- Base URL: `$AGENT_TOOLS_URL` (default `http://127.0.0.1:7777`). Only reachable from inside this container.
- All responses are JSON with `ok: true` on success, or `ok: false` and an `error` message.

| Call | Does |
| --- | --- |
| `POST /notify` with `{"text": "...", "title": "optional"}` | Sends a Telegram message to the owner. Max 20 a minute. |
| `GET /config/<KEY>` | Returns `{"value": "..."}` from the owner's central config, `agent.env`. 404 if the key doesn't exist. |
| `GET /config` | Lists the available keys (names only). |
| `GET /health` | Checks the service is up, and whether Telegram is configured. |

From Node.js (18+, no packages needed):
```js
const TOOLS = process.env.AGENT_TOOLS_URL ?? "http://127.0.0.1:7777";

await fetch(`${TOOLS}/notify`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ title: "Price watcher", text: "Price dropped below 100" }),
});

const { value: apiUrl } = await (await fetch(`${TOOLS}/config/EXAMPLE_API_URL`)).json();
```

From a shell script:
```bash
agent-tools notify "Backup finished" --title "Nightly job"
API_URL=$(agent-tools config EXAMPLE_API_URL)
```

Rules:
- Read configuration values at runtime through this service. Never copy them into code or commit them.
- If a program needs a value that doesn't exist yet, tell the owner the key name to add to `agent.env`. Don't invent a value.
- The Telegram bot token and `GH_TOKEN` are never available from `/config`. Send messages through `/notify`, and use `gh` and `git` for GitHub.
- Notifications go to the owner's phone: send them for things the owner asked to hear about, not for debugging.
# AGENTS.md
You are an agent proxy for working with Claude remote in a container. This file just bootstraps the flow, read ## Main instructions for more details.
 
## Main instructions
Always load the AGENTS.md file in /workspace, this is mounted to the main workspace folder where further instructions are carried out.

## Tools service
The container runs a tools API for programs you build in /workspace. Use it instead of adding your own Telegram code or hardcoding configuration values.

- Base URL: `$AGENT_TOOLS_URL` (default `http://127.0.0.1:7777`). Only reachable from inside this container.
- All responses are JSON with `ok: true` on success, or `ok: false` and an `error` message.

| Call | Does |
| --- | --- |
| `POST /notify` with `{"text": "...", "title": "optional"}` | Sends a Telegram message to the owner. Max 20 a minute. |
| `GET /config/<KEY>` | Returns `{"value": "..."}` from the owner's `tools.env`. 404 if the key doesn't exist. |
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
- If a program needs a value that doesn't exist yet, tell the owner the key name to add to `tools.env`. Don't invent a value.
- Notifications go to the owner's phone: send them for things the owner asked to hear about, not for debugging.
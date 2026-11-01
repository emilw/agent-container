# AGENTS.md
You are an agent proxy for working with Claude remote in a container. This file just bootstraps the flow, read ## Main instructions for more details.
 
## Main instructions
Always load the AGENTS.md file in /workspace, this is mounted to the main workspace folder where further instructions are carried out.

## Starting a new project
When the owner asks to start a new project ("Hi, I want to start a new project"):
1. Agree on a short folder name in lowercase with hyphens, such as `price-watcher`. Ask if it isn't clear from the request.
2. Create `/workspace/<name>/` and keep everything for the project inside it. Never put project files directly in `/workspace`.
3. Write `/workspace/<name>/AGENTS.md` first: what the project is for, how to run and test it, and which tools service features and `agent.env` keys it uses. Keep it current as the project changes.
4. Run `git init` in the folder. Once there is something worth keeping, offer to create a private GitHub repo with `gh repo create`.
5. If `/workspace/AGENTS.md` has its own rules for new projects, follow those instead.

When the owner asks to continue on a project, read its `AGENTS.md` before changing anything.

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

- **You (Claude) use the `agent-tools` MCP tools:** `notify`, `email`, `get_config`, `list_config`, the schedule tools (`add_schedule`, `list_schedules`, `run_schedule`, `remove_schedule`) the log tools (`list_logs`, `get_log`) and `get_usage`. They are connected in every session automatically. Use them directly instead of calling the HTTP API with curl.
- **Programs you build in /workspace use the HTTP API below.** They can't use MCP. Use it instead of adding your own Telegram code or hardcoding configuration values.

Every MCP tool is also an HTTP endpoint, with the same behaviour and limits. To see what's available, read `$AGENT_TOOLS_URL/openapi.json` (an OpenAPI 3.1 description; endpoints marked `x-mcp-tool` are also MCP tools), `GET $AGENT_TOOLS_URL/` for a short list, or run `agent-tools api`. Check it rather than relying only on the table below, which may lag behind new features.

- Base URL: `$AGENT_TOOLS_URL` (default `http://127.0.0.1:7777`). Only reachable from inside this container.
- All responses are JSON with `ok: true` on success, or `ok: false` and an `error` message.

| Call | Does |
| --- | --- |
| `POST /notify` with `{"text": "...", "title": "optional"}` | Sends a Telegram message to the owner. Max 20 a minute. |
| `POST /email` with `{"subject": "...", "text": "...", "html": "optional", "to": "optional"}` | Sends an email from the owner's mail account, to `to` (comma-separated), or to the owner's default address `MAIL_TO` when `to` is left out. Max 30 an hour. |
| `GET /config/<KEY>` | Returns `{"value": "..."}` from the owner's central config, `agent.env`. 404 if the key doesn't exist. |
| `GET /config` | Lists the available keys (names only). |
| `GET /schedules`, `POST /schedules`, `DELETE /schedules/<name>`, `POST /schedules/<name>/run` | List, add or replace, remove and test-run scheduled jobs. See "Scheduled jobs" below. |
| `GET /logs`, `GET /logs/<name>?lines=100` | List the logs and read the end of one: `agent`, or a scheduled job's name. |
| `GET /usage?operation=<id>` | Shows who calls each endpoint and tool: apps, jobs, projects, how often and when last. |
| `GET /health` | Checks the service is up, and whether Telegram is configured. |
| `GET /openapi.json` | Describes every endpoint, its inputs and its responses. |
| `GET /` | Lists the endpoints, and which are also MCP tools. |

From Node.js (18+, no packages needed):
```js
const TOOLS = process.env.AGENT_TOOLS_URL ?? "http://127.0.0.1:7777";

await fetch(`${TOOLS}/notify`, {
  method: "POST",
  headers: { "content-type": "application/json", "x-agent-client": "price-watcher" },
  body: JSON.stringify({ title: "Price watcher", text: "Price dropped below 100" }),
});

const { value: apiUrl } = await (await fetch(`${TOOLS}/config/EXAMPLE_API_URL`, {
  headers: { "x-agent-client": "price-watcher" },
})).json();
```

From a shell script:
```bash
export AGENT_CLIENT=nightly-backup   # names the script in GET /usage
agent-tools notify "Backup finished" --title "Nightly job"
agent-tools email "Morning digest" "Plain-text version" --html out/digest.html
API_URL=$(agent-tools config EXAMPLE_API_URL)
```

Rules:
- Name the calling program: send the header `X-Agent-Client: <project or app name>` on every request (from shell scripts, set `AGENT_CLIENT` for `agent-tools`). The service also detects the calling process and folder by itself, but the name makes `GET /usage` clear.
- Endpoints are versioned and never change incompatibly. Paths without a prefix are v1. If an endpoint is marked `deprecated` (in `/openapi.json`, the `GET /` list, or the MCP tool description), use the replacement it names, usually a `/v2/...` path, in new code.
- Read configuration values at runtime through this service. Never copy them into code or commit them.
- If a program needs a value that doesn't exist yet, tell the owner the key name to add to `agent.env`. Don't invent a value.
- The Telegram bot token, `GH_TOKEN` and `SMTP_PASS` are never available from `/config`. Send messages through `/notify` and `/email`, and use `gh` and `git` for GitHub.
- Use `/email` for longer content the owner wants by mail (reports, digests), and `/notify` for short alerts. Never add your own SMTP code or ask for mail credentials.
- Leave `to` out to mail the owner. Only send to other people when the owner asked for it. If the owner restricted recipients with `MAIL_ALLOWED_TO` and a send is refused, ask them to add the address instead of working around it.
- Notifications go to the owner's phone: send them for things the owner asked to hear about, not for debugging.

## Changing the tools service itself
If you're working on this container's own code (`agent.mjs` in the agent-container repo), follow the COMPATIBILITY RULES next to the API registry in `agent.mjs`: existing endpoints and MCP tools are only ever extended; a breaking change becomes a new `/v2/...` entry and the old one is marked deprecated. CI checks this against `api/openapi.baseline.json`. Check `GET /usage` before deprecating anything.

## Scheduled jobs
When something should run regularly (a daily script, a check every 15 minutes), schedule it with `add_schedule` (or `POST /schedules`). Never use crontab, systemd timers, `at` or a sleep loop: they don't survive container updates, and nobody would see their failures.

- `name`: lowercase letters, digits and hyphens, e.g. `mynewsfeed-morning`. Using an existing name replaces that job.
- `cron`: five fields (minute hour day month weekday) in the container's time zone (`TZ`, default Europe/Stockholm), e.g. `0 7 * * *` for 07:00 every day or `*/15 * * * *` for every 15 minutes. `@daily` and `@hourly` also work.
- `command`: run with `sh` in `cwd`, which must be inside `/workspace`, usually the project's folder. The job gets `AGENT_JOB_NAME` in its environment.
- `notify`: `failure` (default) sends the owner a Telegram message when a run fails, `always` after every run, `never` not at all.
- `timeoutMinutes`: default 60. A run still going after that is stopped.

A run is skipped if the previous one is still going. Each job's output goes to its own log: `get_log name=<job>`.

After adding a job: test it with `run_schedule`, read the result with `get_log`, and write the schedule into the project's `AGENTS.md`. When a job fails, start with `get_log` for that job, and `get_log name=agent` for the container's own log.
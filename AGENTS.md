# AGENTS.md: maintaining agent-container

These instructions are for coding agents (Claude Code, Codex or others) working on this
repository, which builds the agent-container Docker image. They are not part of the image.

The instructions for agents running *inside* the container are in
[container/AGENTS.md](container/AGENTS.md); the image installs that file as
`/etc/claude-code/CLAUDE.md`. Edit it when the container's behaviour for its users changes,
and never put repository-maintenance instructions there.

## Working on an issue

Every GitHub issue is handled with the SDD (spec-driven development) flow in
[docs/sdd-flow.md](docs/sdd-flow.md): functional spec, technical spec and implementation,
each tracked as a sub-issue of the reported issue, with the owner approving each step. Small
bugs take a shorter path. Read that file before starting on an issue, and follow it even if
the request is just "fix #12".

## Layout

| Path | What |
| --- | --- |
| `agent.mjs` | The supervisor: Telegram login relay, Remote Control in tmux, the tools API and MCP server (the `API` registry), scheduler, usage tracking |
| `agent-run` | Runs one scheduled job: logging, state, timeout, failure notification |
| `agent-tools` | Command-line client for the tools API |
| `smtp.mjs` | Dependency-free SMTP client used by `/email` |
| `container/AGENTS.md` | Instructions for agents inside the container (copied into the image) |
| `Dockerfile`, `tmux.conf`, `agent.env.example`, `docker-compose.yml` | The image, and what the owner deploys on the NAS |
| `scripts/check-api.mjs` | API compatibility check, run by CI on pull requests |
| `.github/workflows/docker.yml` | Builds, checks and publishes the image to ghcr.io |
| `docs/` | Maintenance documentation, not copied into the image |

## Rules

- **The tools API and MCP tools never break.** Follow the COMPATIBILITY RULES next to the
  `API` registry in `agent.mjs`: existing endpoints, tools, inputs and response fields are only
  ever extended. If a change would break one (remove or rename it, change a type, make an
  optional input required), stop and ask the owner whether that's intended, and suggest a
  `/v2/...` version next to the old one. Check `GET /usage` in the running container before
  deprecating anything. CI compares the API with main's and fails on a breaking change.
- **Every tools feature is an `API` registry entry**, so it gets a REST endpoint, an MCP tool,
  an OpenAPI entry and an `agent-tools` command together. Describe it in `container/AGENTS.md`
  if agents in the container should use it, and in `README.md` for the owner.
- **No new npm dependencies.** The image's scripts use only Node 22's standard library.
- **No secrets in the repo.** All configuration lives in `/config` on the owner's NAS
  (`agent.env`); document new keys in `agent.env.example`.
- **Test in Docker before opening a pull request.** There is no unit test suite. Build the
  image, start it with a test config, and exercise the change (curl the endpoint, run the
  job, read the logs). Use fakes for outside services such as Telegram or SMTP. Say in the PR
  what you tested and what you couldn't.
- **Pull requests:** branch from `main`, one concern per PR, and link the issue. CI must pass:
  the image build, plus the API compatibility check. Never merge your own PR; the owner merges.

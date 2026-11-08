# AGENTS.md: maintaining agent-container

These instructions are for any coding agent working on this repository, which builds the
agent-container Docker image. They are not part of the image.

The instructions for agents running *inside* the container are in
[container/AGENTS.md](container/AGENTS.md); the image installs that file where the
container's agent tool loads it (see the Dockerfile). Edit it when the container's behaviour
for its users changes, and never put repository-maintenance instructions there.

## Working on an issue

Every GitHub issue is handled with the SDD (spec-driven development) playbook in
[container/sdd-flow.md](container/sdd-flow.md): functional spec, technical spec and
implementation, each tracked as a sub-issue of the reported issue, with the owner approving
each step by closing its sub-issue. Small bugs take a shorter path. Read that file before
starting on an issue, and follow it even if the request is just "fix #12". It's the same
playbook the image ships for the issue flow of workspace apps; this repository uses it by
hand, since no container watches it.

## Layout

| Path | What |
| --- | --- |
| `agent.mjs` | The supervisor: Telegram login relay, Remote Control in tmux, the tools API and MCP server (the `API` registry), scheduler, usage tracking |
| `agent-run` | Runs one scheduled job: logging, state, timeout, failure notification |
| `agent-tools` | Command-line client for the tools API |
| `smtp.mjs` | Dependency-free SMTP client used by `/email` |
| `sdd.mjs` | The issue flow: watches workspace apps' GitHub issues, decides the step (`decide()`), keeps the status comment, runs one agent step at a time |
| `container/AGENTS.md` | Instructions for agents inside the container (copied into the image) |
| `container/sdd-flow.md` | The SDD playbook, for the issue flow and for this repository's issues (copied into the image) |
| `scripts/test-sdd.mjs` | Tests `decide()` against fixed GitHub data: `node scripts/test-sdd.mjs` |
| `scripts/fake-sdd-agent.mjs` | A stand-in agent for testing the issue flow in Docker without tokens, against a sandbox repository |
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
- **Keep everything agent-tool neutral** except the parts that can't be. Today the container
  runs Claude Code, and only these are specific to it: the login relay, Remote Control, the
  health check and the workspace trust step in `agent.mjs`; MCP server registration
  (`registerMcpServer`); the issue flow's default run command (`SDD_DEFAULT_AGENT_COMMAND`);
  `CLAUDE_CONFIG_DIR`; and where the Dockerfile installs `container/AGENTS.md`. The README lists them under "Agent tool: Claude Code". Keep new
  tool-specific code next to those parts, and keep instructions, the tools API, MCP tools,
  scheduling and docs free of a particular tool's names.
- **No new npm dependencies.** The image's scripts use only Node 22's standard library.
- **No secrets in the repo.** All configuration lives in `/config` on the owner's NAS
  (`agent.env`); document new keys in `agent.env.example`.
- **Test in Docker before opening a pull request.** There is no unit test suite. Build the
  image, start it with a test config, and exercise the change (curl the endpoint, run the
  job, read the logs). Use fakes for outside services such as Telegram or SMTP. Say in the PR
  what you tested and what you couldn't. For the issue flow, run `scripts/test-sdd.mjs`, and
  test the plumbing with `scripts/fake-sdd-agent.mjs` as `SDD_AGENT_COMMAND` against a
  sandbox repository such as `emilw/sdd-sandbox`, never a real app's.
- **Pull requests:** branch from `main`, one concern per PR, and link the issue. CI must pass:
  the image build, plus the API compatibility check. Never merge your own PR; the owner merges.

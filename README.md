# agent-container

Claude Code running as a Remote Control server, for a NAS. Sessions show up in
claude.ai/code, the Claude mobile app and Claude Desktop.

The image is built by GitHub Actions and published to
`ghcr.io/emilw/agent-container` (amd64 + arm64) on every push to `main` and weekly.

## First-time setup on the NAS

Copy `docker-compose.yml` to the NAS and set the `/workspace` volume path. The
container runs as uid 1000, so the mounted folders must be writable by it.

```bash
mkdir -p claude-config && sudo chown 1000:1000 claude-config
docker compose pull

# 1. Device login (claude.ai subscription; API keys / setup-token don't work with Remote Control)
docker compose run --rm claude claude auth login

# 2. Accept the one-time Remote Control prompt with "y", then Ctrl+C
docker compose run --rm claude claude remote-control

# 3. Run it
docker compose up -d
```

## Updating

```bash
docker compose pull && docker compose up -d
```

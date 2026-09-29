FROM node:22-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
      git ca-certificates curl ripgrep tmux openssh-client jq procps tini \
    && rm -rf /var/lib/apt/lists/*

# Pinned per build; CI rebuilds weekly to pick up new releases.
ARG CLAUDE_CODE_VERSION=latest
RUN npm install -g @anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}

# Global npm install is root-owned, so in-container auto-update can't work anyway.
ENV DISABLE_AUTOUPDATER=1 \
    CLAUDE_CONFIG_DIR=/config/claude \
    AGENT_TOOLS_URL=http://127.0.0.1:7777

COPY --chmod=755 agent.mjs tmux.conf agent.env.example tools.env.example /opt/agent/
COPY --chmod=755 agent-tools /usr/local/bin/agent-tools

# Instructions for every Claude session in the container (managed CLAUDE.md location on Linux)
COPY --chmod=755 AGENTS.MD /etc/claude-code/CLAUDE.md

RUN mkdir -p /config /workspace && chown node:node /config /workspace

USER node
WORKDIR /workspace

ENTRYPOINT ["/usr/bin/tini", "--", "node", "/opt/agent/agent.mjs"]

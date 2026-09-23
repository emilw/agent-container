FROM node:22-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
      git ca-certificates curl ripgrep tmux openssh-client jq \
    && rm -rf /var/lib/apt/lists/*

# Pinned per build; CI rebuilds weekly to pick up new releases.
ARG CLAUDE_CODE_VERSION=latest
RUN npm install -g @anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}

# Global npm install is root-owned, so in-container auto-update can't work anyway.
ENV DISABLE_AUTOUPDATER=1 \
    CLAUDE_CONFIG_DIR=/home/node/.claude

RUN mkdir -p /home/node/.claude /workspace && chown -R node:node /home/node/.claude /workspace

USER node
WORKDIR /workspace

CMD ["claude", "remote-control", "--name", "nas"]

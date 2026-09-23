FROM node:22-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
      git ca-certificates curl ripgrep tmux openssh-client jq procps tini \
    && rm -rf /var/lib/apt/lists/*

# Pinned per build; CI rebuilds weekly to pick up new releases.
ARG CLAUDE_CODE_VERSION=latest
RUN npm install -g @anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}

# Global npm install is root-owned, so in-container auto-update can't work anyway.
ENV DISABLE_AUTOUPDATER=1 \
    CLAUDE_CONFIG_DIR=/config/claude

COPY --chmod=755 entrypoint.sh /opt/agent/entrypoint.sh
COPY --chmod=644 agent.env.example /opt/agent/agent.env.example

RUN mkdir -p /config /workspace && chown node:node /config /workspace

USER node
WORKDIR /workspace

# -g: forward stop signals to the whole process group, not just the script
ENTRYPOINT ["/usr/bin/tini", "-g", "--", "/opt/agent/entrypoint.sh"]

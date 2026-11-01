FROM node:22-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
      git ca-certificates curl ripgrep tmux openssh-client jq procps tini tzdata \
    && rm -rf /var/lib/apt/lists/*

# GitHub CLI from GitHub's own apt repository (Debian's package is years old).
# git uses it for github.com credentials, so `git push` works once gh is logged in.
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
      -o /usr/share/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
      > /etc/apt/sources.list.d/github-cli.list \
    && apt-get update && apt-get install -y --no-install-recommends gh \
    && rm -rf /var/lib/apt/lists/* \
    && git config --system credential.https://github.com.helper "" \
    && git config --system --add credential.https://github.com.helper "!gh auth git-credential"

# supercronic runs scheduled jobs (cron for containers). Checksums from the release notes.
ARG TARGETARCH
ARG SUPERCRONIC_VERSION=v0.2.51
RUN case "$TARGETARCH" in       amd64) sha1=1692066e350a88ff4d7d6474fe3c7a6c41ec5e89 ;;       arm64) sha1=9d4c2000493215a1898502b2fc2dada3e8ea8c7a ;;       *) echo "no supercronic build for $TARGETARCH" >&2; exit 1 ;;     esac     && curl -fsSLo /usr/local/bin/supercronic       "https://github.com/aptible/supercronic/releases/download/${SUPERCRONIC_VERSION}/supercronic-linux-${TARGETARCH}"     && echo "${sha1}  /usr/local/bin/supercronic" | sha1sum -c -     && chmod +x /usr/local/bin/supercronic

# Pinned per build; CI rebuilds weekly to pick up new releases.
ARG CLAUDE_CODE_VERSION=latest
RUN npm install -g @anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}

# Global npm install is root-owned, so in-container auto-update can't work anyway.
ENV DISABLE_AUTOUPDATER=1 \
    CLAUDE_CONFIG_DIR=/config/claude \
    GH_CONFIG_DIR=/config/gh \
    AGENT_TOOLS_URL=http://127.0.0.1:7777     TZ=Europe/Stockholm

COPY --chmod=755 agent.mjs smtp.mjs tmux.conf agent.env.example /opt/agent/
COPY --chmod=755 agent-tools agent-run /usr/local/bin/

# Instructions for every Claude session in the container (managed CLAUDE.md location on Linux)
COPY --chmod=755 AGENTS.MD /etc/claude-code/CLAUDE.md

RUN mkdir -p /config /workspace && chown node:node /config /workspace

USER node
WORKDIR /workspace

ENTRYPOINT ["/usr/bin/tini", "--", "node", "/opt/agent/agent.mjs"]

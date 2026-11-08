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

COPY --chmod=755 agent.mjs smtp.mjs sdd.mjs tmux.conf agent.env.example container/sdd-flow.md /opt/agent/
COPY --chmod=755 agent-tools agent-run /usr/local/bin/

# Instructions for every Claude session in the container (managed CLAUDE.md location on Linux).
# Only container/AGENTS.md: the repo-root AGENTS.md and docs/ are about maintaining this image.
COPY --chmod=755 container/AGENTS.md /etc/claude-code/CLAUDE.md

# Which build this is, for get_version (GET /version). CI passes the commit; a local build can
# pass --build-arg GIT_COMMIT=$(git rev-parse HEAD). Declared last, so a new commit only
# rebuilds this layer.
ARG GIT_COMMIT=unknown
ARG GIT_REF=
ARG SOURCE_URL=
RUN node -e 'const e = process.env; \
      const tool = require("/usr/local/lib/node_modules/@anthropic-ai/claude-code/package.json"); \
      console.log(JSON.stringify({ commit: e.GIT_COMMIT, ref: e.GIT_REF || null, source: e.SOURCE_URL || null, \
        builtAt: new Date().toISOString(), agentTool: { name: "claude-code", version: tool.version } }, null, 2))' \
      > /opt/agent/version.json

RUN mkdir -p /config /workspace && chown node:node /config /workspace

USER node
WORKDIR /workspace

ENTRYPOINT ["/usr/bin/tini", "--", "node", "/opt/agent/agent.mjs"]

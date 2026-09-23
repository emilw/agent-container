#!/usr/bin/env bash
# Runs `claude remote-control`, waits for a login when there is none, and sends
# Telegram alerts when the login is missing, stops working, or the server exits.
set -uo pipefail

CONFIG_DIR=/config
ENV_FILE=$CONFIG_DIR/agent.env

log() { echo "[agent] $*"; }

if [[ ! -w $CONFIG_DIR ]]; then
  log "$CONFIG_DIR is not writable by uid $(id -u). On the NAS run: sudo chown -R 1000:1000 <config folder>"
  exec sleep infinity
fi

mkdir -p "$CLAUDE_CONFIG_DIR"
if [[ ! -f $ENV_FILE ]]; then
  cp /opt/agent/agent.env.example "$ENV_FILE"
  log "Created $ENV_FILE. Fill in TELEGRAM_TOKEN and ALLOWED_USER_IDS, then restart the container."
fi

# Parse KEY=value lines instead of sourcing, so the file can't run commands.
load_env() {
  local line key val n=0
  while IFS= read -r line || [[ -n $line ]]; do
    n=$((n + 1))
    line=${line%$'\r'}
    [[ $line =~ ^[[:space:]]*(#|$) ]] && continue
    if [[ ! $line =~ ^[[:space:]]*([A-Za-z_][A-Za-z0-9_]*)=(.*)$ ]]; then
      log "Ignoring malformed line $n in agent.env"
      continue
    fi
    key=${BASH_REMATCH[1]}
    val=${BASH_REMATCH[2]}
    if [[ $val =~ ^\"(.*)\"$ || $val =~ ^\'(.*)\'$ ]]; then val=${BASH_REMATCH[1]}; fi
    export "$key=$val"
  done < "$1"
}
load_env "$ENV_FILE"

RC_NAME=${RC_NAME:-nas}
CONTAINER_NAME=${CONTAINER_NAME:-claude}
CHECK_INTERVAL_MINUTES=${CHECK_INTERVAL_MINUTES:-30}
HEALTH_PING=${HEALTH_PING:-1}

# Remote Control only works with the claude.ai login; these would take precedence over it.
for var in ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN CLAUDE_CODE_OAUTH_TOKEN; do
  if [[ -n ${!var:-} ]]; then
    log "Ignoring $var: Remote Control needs the claude.ai login."
    unset "$var"
  fi
done

notify() {
  log "$1"
  [[ -n ${TELEGRAM_TOKEN:-} && -n ${ALLOWED_USER_IDS:-} ]] || return 0
  local id
  for id in ${ALLOWED_USER_IDS//,/ }; do
    curl -fsS -m 15 -o /dev/null "https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage" \
      --data-urlencode "chat_id=$id" \
      --data-urlencode "text=[$RC_NAME] $1" \
      || log "Telegram message to $id failed (has that user sent /start to the bot?)"
  done
}

logged_in() { claude auth status >/dev/null 2>&1; }

LOGIN_HELP="Log in on the NAS with:
docker exec -it $CONTAINER_NAME claude auth login"

wait_for_login() {
  logged_in && return
  notify "Claude is not logged in. $LOGIN_HELP

First time only, then accept Remote Control:
docker attach $CONTAINER_NAME
answer y, then detach with Ctrl+P Ctrl+Q"
  local waited=0
  until logged_in; do
    sleep 30
    waited=$((waited + 30))
    if (( waited >= 86400 )); then
      notify "Still waiting for a Claude login. $LOGIN_HELP"
      waited=0
    fi
  done
  notify "Claude login found."
}

watchdog() {
  local problem="" msg out now last_ping=0
  while sleep $((CHECK_INTERVAL_MINUTES * 60)); do
    if ! logged_in; then
      msg="Claude is logged out. $LOGIN_HELP"
    elif [[ $HEALTH_PING == 1 ]]; then
      now=$(date +%s)
      (( now - last_ping >= 86400 )) || continue
      last_ping=$now
      if out=$(cd /tmp && timeout 180 claude -p --model haiku "Reply with just OK" 2>&1); then
        msg=""
      else
        msg="Claude health check failed, the login may have expired:
${out: -300}

$LOGIN_HELP"
      fi
    else
      msg=""
    fi

    if [[ -n $msg && $msg != "$problem" ]]; then
      notify "$msg"
    elif [[ -z $msg && -n $problem ]]; then
      notify "Claude login works again. Restarting the Remote Control server."
      pkill -TERM -f "claude remote-control" || true
    fi
    problem=$msg
  done
}

wait_for_login
watchdog &

while true; do
  notify "Remote Control server starting."
  # shellcheck disable=SC2086 # RC_ARGS is intentionally split into flags
  claude remote-control --name "$RC_NAME" ${RC_ARGS:-}
  notify "Remote Control server exited with code $?. Restarting in 60 seconds."
  sleep 60
  wait_for_login
done

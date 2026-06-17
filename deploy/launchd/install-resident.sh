#!/bin/bash
# Install resident postline bridges + keeper as macOS LaunchAgents.
#
# Config-driven (docs/designs/resident-deploy.md): reads a resident config
# listing which IM channels to keep alive on THIS host + the keeper's repo
# allowlist, renders one LaunchAgent per channel + one keeper, and loads
# them. Idempotent: re-running re-renders + kickstarts.
#
# Config file (default ~/.postline/resident.conf), shell-sourced:
#   RESIDENT_CHANNELS="telegram"          # space-separated: telegram slack ...
#   KEEPER_REPOS="$HOME/Downloads/ClaudeCode/postline"   # space-separated abs cwds
#   POSTLINE_DIR="$HOME/Downloads/ClaudeCode/postline"   # repo checkout
#   ENV_FILE="$HOME/.cc-dev/.env"         # exports CC_*_TOKEN / CC_DOORBELL_*
#   NODE_BIN="/opt/homebrew/bin/node"
#   DOORBELL_URL="http://localhost:9998"  # the keeper attaches here
#
# Tokens + secrets live only in ENV_FILE (never in the repo). lark/feishu is
# NOT managed here — its bridge runs on EC2; this is mac-side residents only.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
CONF="${1:-$HOME/.postline/resident.conf}"
LA="$HOME/Library/LaunchAgents"
PL_HOME="$HOME/.postline"
LOG_DIR="$PL_HOME/resident-logs"
LAUNCHER_DIR="$PL_HOME/resident"

if [[ ! -f "$CONF" ]]; then
  echo "no resident config at $CONF — copy resident.conf.example and edit." >&2
  exit 2
fi
# shellcheck disable=SC1090
source "$CONF"

: "${RESIDENT_CHANNELS:?set RESIDENT_CHANNELS in $CONF}"
: "${POSTLINE_DIR:?set POSTLINE_DIR}"
: "${ENV_FILE:?set ENV_FILE}"
NODE_BIN="${NODE_BIN:-/opt/homebrew/bin/node}"
DOORBELL_URL="${DOORBELL_URL:-http://localhost:9998}"

mkdir -p "$LA" "$LOG_DIR" "$LAUNCHER_DIR"

render() { # template dst  (then key=val pairs)
  local tpl="$1" dst="$2"; shift 2
  local s; s="$(cat "$tpl")"
  while [[ $# -gt 0 ]]; do
    s="${s//\{\{$1\}\}/$2}"; shift 2
  done
  printf '%s\n' "$s" >"$dst"
}

load() { # plist label
  local plist="$1" label="$2"
  launchctl unload "$plist" 2>/dev/null || true
  launchctl load "$plist"
  launchctl kickstart -k "gui/$(id -u)/$label" 2>/dev/null || true
  echo "loaded $label"
}

# --- one bridge LaunchAgent per channel ---
for ch in $RESIDENT_CHANNELS; do
  label="com.cc.postline-$ch"
  launcher="$LAUNCHER_DIR/$ch-launcher.sh"
  cat >"$launcher" <<EOF
#!/bin/bash
set -a; . "$ENV_FILE"; set +a
export PATH="\$(dirname "$NODE_BIN"):\$HOME/.local/bin:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin"
cd "$POSTLINE_DIR"
exec "$NODE_BIN" packages/cli/dist/bin.js $ch
EOF
  chmod +x "$launcher"
  render "$HERE/postline-bridge.plist.template" "$LA/$label.plist" \
    LABEL "$label" CHANNEL "$ch" LAUNCHER "$launcher" LOG_DIR "$LOG_DIR"
  load "$LA/$label.plist" "$label"
done

# --- keeper LaunchAgent (auto-start workers on wake) ---
if [[ -n "${KEEPER_REPOS:-}" ]]; then
  label="com.cc.postline-keeper"
  launcher="$LAUNCHER_DIR/keeper-launcher.sh"
  repo_args=""
  for r in $KEEPER_REPOS; do repo_args="$repo_args --repo \"$r\""; done
  cat >"$launcher" <<EOF
#!/bin/bash
set -a; . "$ENV_FILE"; set +a
export PATH="\$(dirname "$NODE_BIN"):\$HOME/.local/bin:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin"
export CC_DOORBELL_URL="$DOORBELL_URL"
cd "$POSTLINE_DIR"
exec "$NODE_BIN" packages/cli/dist/bin.js cc-worker keeper $repo_args
EOF
  chmod +x "$launcher"
  render "$HERE/postline-keeper.plist.template" "$LA/$label.plist" \
    LABEL "$label" LAUNCHER "$launcher" LOG_DIR "$LOG_DIR"
  load "$LA/$label.plist" "$label"
fi

echo "done. logs in $LOG_DIR/. stop a unit: launchctl bootout gui/$(id -u)/com.cc.postline-<channel|keeper>"

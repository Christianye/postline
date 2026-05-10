#!/bin/bash
# One-time installer for postline on a Linux host (EC2 / Hetzner / Raspberry Pi / whatever).
# Run as the service user (NOT root). Must have:
#   - nvm + node 22 already installed
#   - gh auth already configured (only needed if you use github tools at runtime)
#   - ~/.ssh keys that can clone $MEMORY_REPO (if you use the memory tool)
#   - sudo privileges for installing the systemd unit + logrotate

set -euo pipefail

# Load nvm so pnpm/node are on PATH (non-interactive shells don't source ~/.bashrc).
export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
if [[ -s "$NVM_DIR/nvm.sh" ]]; then
  # shellcheck disable=SC1091
  . "$NVM_DIR/nvm.sh"
fi

REPO_DIR="${REPO_DIR:-$HOME/postline}"
CC_HOME="${CC_HOME:-$HOME/.cc}"
MEMORY_DIR="${MEMORY_DIR:-$CC_HOME/memory}"
REPO_URL="${REPO_URL:-https://github.com/Christianye/postline.git}"

# MEMORY_REPO must be set by the operator when the memory tool is enabled.
# If unset, we skip the memory clone — the bot can still run without memory.
MEMORY_REPO="${MEMORY_REPO:-}"

log() { printf '\033[36m[install]\033[0m %s\n' "$*" >&2; }
die() { printf '\033[31m[install] ERROR:\033[0m %s\n' "$*" >&2; exit 1; }

# --- pnpm ---
if ! command -v pnpm >/dev/null 2>&1; then
  log "installing pnpm globally under current node..."
  npm install -g pnpm@latest
else
  log "pnpm already installed: $(pnpm --version)"
fi

# --- clone / pull repo ---
if [[ -d "$REPO_DIR/.git" ]]; then
  log "updating existing repo at $REPO_DIR"
  git -C "$REPO_DIR" fetch --quiet origin main
  git -C "$REPO_DIR" reset --hard origin/main
else
  log "cloning $REPO_URL into $REPO_DIR"
  git clone --quiet "$REPO_URL" "$REPO_DIR"
fi

# --- install deps + build ---
log "installing node deps"
cd "$REPO_DIR"
pnpm install --frozen-lockfile

log "building all packages"
pnpm -r build

# --- $CC_HOME layout ---
log "ensuring $CC_HOME layout"
mkdir -p "$CC_HOME" "$CC_HOME/workspace" "$CC_HOME/logs"
chmod 700 "$CC_HOME"

# --- memory repo (optional) ---
if [[ -n "$MEMORY_REPO" ]]; then
  if [[ -d "$MEMORY_DIR/.git" ]]; then
    log "updating memory repo"
    git -C "$MEMORY_DIR" pull --rebase --autostash --quiet || die "memory pull failed"
  else
    log "cloning $MEMORY_REPO into $MEMORY_DIR"
    git clone --quiet "$MEMORY_REPO" "$MEMORY_DIR"
  fi

  # Memory sync cron — pull every 5 minutes.
  CRON_LINE="*/5 * * * * cd $MEMORY_DIR && git pull --rebase --autostash --quiet >> $CC_HOME/logs/memory-sync.log 2>&1"
  if ! (crontab -l 2>/dev/null | grep -qF "$MEMORY_DIR && git pull"); then
    log "installing memory-sync cron"
    ( crontab -l 2>/dev/null ; echo "$CRON_LINE" ) | crontab -
  else
    log "memory-sync cron already present"
  fi
else
  log "MEMORY_REPO not set; skipping memory clone + cron. Run memory tool will fail at runtime until you set it."
fi

# --- systemd unit ---
UNIT_SRC="$REPO_DIR/deploy/systemd/cc.service"
UNIT_DST="/etc/systemd/system/cc.service"
if [[ ! -f "$UNIT_SRC" ]]; then
  die "systemd unit missing at $UNIT_SRC"
fi
if ! sudo diff -q "$UNIT_SRC" "$UNIT_DST" >/dev/null 2>&1; then
  log "installing systemd unit (requires sudo)"
  sudo cp "$UNIT_SRC" "$UNIT_DST"
  sudo systemctl daemon-reload
fi

# --- logrotate ---
LOGROTATE_CONF="/etc/logrotate.d/cc"
if [[ ! -f "$LOGROTATE_CONF" ]]; then
  log "installing logrotate config"
  sudo tee "$LOGROTATE_CONF" >/dev/null <<LOG
$CC_HOME/logs/*.log {
  daily
  rotate 7
  compress
  delaycompress
  missingok
  notifempty
  copytruncate
}
LOG
fi

log "install complete."
log "next steps:"
log "  1. ensure $CC_HOME/env exists with CC_FEISHU_APP_ID / CC_FEISHU_APP_SECRET / CC_ALLOWLIST_OPEN_IDS"
log "     OR place a postline.config.ts at $REPO_DIR"
log "  2. sudo systemctl enable --now cc.service"
log "  3. journalctl -u cc -f"

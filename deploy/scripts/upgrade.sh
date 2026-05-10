#!/bin/bash
# Pull latest code, rebuild, restart cc.service.
set -euo pipefail

REPO_DIR="${REPO_DIR:-/home/ubuntu/postline}"

# Load nvm so pnpm/node are on PATH (SSM non-interactive shells skip ~/.bashrc).
export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
if [[ -s "$NVM_DIR/nvm.sh" ]]; then
  # shellcheck disable=SC1091
  . "$NVM_DIR/nvm.sh"
fi

log() { printf '\033[36m[upgrade]\033[0m %s\n' "$*" >&2; }

cd "$REPO_DIR"
git fetch --quiet origin main
LOCAL_SHA=$(git rev-parse HEAD)
REMOTE_SHA=$(git rev-parse origin/main)
FORCE="${FORCE:-0}"

if [[ "$LOCAL_SHA" == "$REMOTE_SHA" && "$FORCE" != "1" ]]; then
  log "already up to date at ${LOCAL_SHA:0:7}; pass FORCE=1 to rebuild+restart anyway"
else
  if [[ "$LOCAL_SHA" == "$REMOTE_SHA" ]]; then
    log "FORCE=1 rebuild at ${LOCAL_SHA:0:7}"
  else
    log "updating ${LOCAL_SHA:0:7} -> ${REMOTE_SHA:0:7}"
    git reset --hard origin/main
  fi
  pnpm install --frozen-lockfile
  pnpm -r build
  sudo systemctl restart cc.service
  log "restarted cc.service"
fi

sudo systemctl status cc.service --no-pager --lines=5

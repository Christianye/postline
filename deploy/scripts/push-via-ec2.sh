#!/bin/bash
# Push unpushed commits via EC2 (bypass laptop-side pre-push hooks).
#
# Usage:
#   deploy/scripts/push-via-ec2.sh                 # push unpushed commits on main
#   deploy/scripts/push-via-ec2.sh --tag v0.1.7    # also create + push that tag
#
# Environment:
#   EC2_INSTANCE_ID  required — your SSM-managed instance id (e.g. i-0123...)
#   EC2_REGION       default: us-west-2
#   EC2_REPO_DIR     default: /home/ubuntu/postline
#   EC2_USER         default: ubuntu
#
# Requires:
#   - aws CLI with SSM send-command + get-command-invocation perms
#   - Local git tree whose origin matches the EC2 checkout
#   - EC2 already authed for `git push origin` (SSH key or gh https)
set -euo pipefail

EC2_INSTANCE_ID="${EC2_INSTANCE_ID:?set EC2_INSTANCE_ID to your SSM-managed instance id}"
EC2_REGION="${EC2_REGION:-us-west-2}"
EC2_REPO_DIR="${EC2_REPO_DIR:-/home/ubuntu/postline}"
EC2_USER="${EC2_USER:-ubuntu}"

TAG=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --tag) TAG="$2"; shift 2 ;;
    -h|--help) sed -n '2,15p' "$0"; exit 0 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

log() { printf '\033[36m[push-via-ec2]\033[0m %s\n' "$*" >&2; }
die() { printf '\033[31m[push-via-ec2] ERROR:\033[0m %s\n' "$*" >&2; exit 1; }

command -v aws >/dev/null || die "aws CLI not found"
command -v jq  >/dev/null || die "jq not found"

REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" || die "not inside a git tree"
cd "$REPO_ROOT"

BRANCH="$(git rev-parse --abbrev-ref HEAD)"
UPSTREAM="$(git rev-parse --abbrev-ref --symbolic-full-name '@{upstream}' 2>/dev/null || echo "origin/$BRANCH")"
git rev-parse --verify --quiet "$UPSTREAM" >/dev/null || die "upstream ref $UPSTREAM not found (did you 'git fetch origin'?)"
AHEAD="$(git rev-list --count "$UPSTREAM..HEAD")"
[[ "$AHEAD" -gt 0 ]] || die "HEAD is not ahead of $UPSTREAM — nothing to push"
log "pushing $AHEAD commit(s) ahead of $UPSTREAM via $EC2_INSTANCE_ID"

BUNDLE="$(mktemp -t postline-bundle.XXXXXX).bundle"
trap 'rm -f "$BUNDLE" "${BUNDLE}.json"' EXIT
git bundle create "$BUNDLE" "$UPSTREAM..HEAD" >/dev/null
log "bundle $(wc -c < "$BUNDLE") bytes at $BUNDLE"

HEAD_SHA="$(git rev-parse HEAD)"
BASE_SHA="$(git rev-parse "$UPSTREAM")"

BUNDLE_B64="$(base64 -i "$BUNDLE" | tr -d '\n')"

# Tag creation is done on EC2 against the fetched ref so the tag object
# records only what we just shipped. Remote-side history already has BASE_SHA.
REMOTE_BUNDLE_PATH="/tmp/postline-push-$(date +%s).bundle"

build_cmd() {
  local -a lines=(
    "set -e"
    "echo $BUNDLE_B64 | base64 -d > $REMOTE_BUNDLE_PATH"
    "cd $EC2_REPO_DIR"
    "sudo -u $EC2_USER git fetch $REMOTE_BUNDLE_PATH HEAD:refs/bundles/push-staging"
    "sudo -u $EC2_USER git rev-parse refs/bundles/push-staging | grep -qx $HEAD_SHA"
    # HUSKY=0 disables any client-side git hooks the repo configures. EC2 is a
    # relay, not a dev machine — hooks like pre-push that expect pnpm on PATH
    # would otherwise fail under the sudo non-interactive shell.
    "sudo -u $EC2_USER HUSKY=0 git push origin refs/bundles/push-staging:refs/heads/$BRANCH"
  )
  if [[ -n "$TAG" ]]; then
    lines+=(
      "sudo -u $EC2_USER git tag $TAG refs/bundles/push-staging"
      "sudo -u $EC2_USER HUSKY=0 git push origin $TAG"
    )
  fi
  lines+=(
    "sudo -u $EC2_USER git update-ref -d refs/bundles/push-staging"
    "rm -f $REMOTE_BUNDLE_PATH"
    "echo DONE"
  )
  printf '%s\n' "${lines[@]}"
}

PARAMS_JSON="$(python3 -c '
import json, sys
cmds = sys.stdin.read().splitlines()
print(json.dumps({"commands": cmds}))
' <<< "$(build_cmd)")"

log "send-command → $EC2_INSTANCE_ID"
CMD_ID="$(aws ssm send-command \
  --region "$EC2_REGION" \
  --instance-ids "$EC2_INSTANCE_ID" \
  --document-name AWS-RunShellScript \
  --parameters "$PARAMS_JSON" \
  --query 'Command.CommandId' \
  --output text)"

log "command id: $CMD_ID"

for _ in {1..30}; do
  sleep 2
  STATUS="$(aws ssm get-command-invocation \
    --region "$EC2_REGION" \
    --instance-id "$EC2_INSTANCE_ID" \
    --command-id "$CMD_ID" \
    --query Status --output text 2>/dev/null || echo Pending)"
  case "$STATUS" in
    Success) break ;;
    Failed|Cancelled|TimedOut)
      aws ssm get-command-invocation \
        --region "$EC2_REGION" \
        --instance-id "$EC2_INSTANCE_ID" \
        --command-id "$CMD_ID" \
        --query '[Status,StandardOutputContent,StandardErrorContent]' \
        --output text
      die "remote push failed ($STATUS)"
      ;;
    *) ;;
  esac
done

[[ "$STATUS" == Success ]] || die "command did not finish in time (last status: $STATUS)"

aws ssm get-command-invocation \
  --region "$EC2_REGION" \
  --instance-id "$EC2_INSTANCE_ID" \
  --command-id "$CMD_ID" \
  --query StandardOutputContent \
  --output text

log "fast-forward local upstream ref"
git fetch origin "$BRANCH" >/dev/null
[[ -n "$TAG" ]] && git fetch origin "refs/tags/$TAG:refs/tags/$TAG" >/dev/null

log "done: origin/$BRANCH → $HEAD_SHA${TAG:+, tag $TAG}"

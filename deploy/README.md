# Deploy — EC2 systemd

Production pattern: one small Linux host (EC2, Hetzner, home server, whatever) running postline via systemd 24/7.

## Prerequisites

- Node 22+ as the runtime user (nvm-managed is fine)
- `sudo` privileges for installing the systemd unit
- An SSH key that can read/write your private memory repo (if you're using memory — see below)
- Credentials for your chosen LLM provider:
  - Bedrock: IAM role / AWS profile / static creds in env
  - Anthropic: `ANTHROPIC_API_KEY` in env
- Optional: `gh auth login` if you plan to use the github tools

## Install

```bash
# 1. clone postline
ssh <host>
git clone https://github.com/Christianye/postline.git
cd postline

# 2. run the installer (needs to be idempotent; safe to re-run)
REPO_URL=https://github.com/Christianye/postline.git \
MEMORY_REPO=git@github.com:<YOU>/<your-memory-repo>.git \
bash deploy/scripts/install.sh
```

The installer:

- installs pnpm if missing
- runs `pnpm install --frozen-lockfile` + `pnpm -r build`
- clones your memory repo into `$CC_HOME/memory` (default `$HOME/.cc/memory`) — only when `MEMORY_REPO=...` is passed
- installs the memory-pull cron (every 5 minutes) when memory is enabled
- **renders** the systemd unit template (`deploy/systemd/cc.service.template`) with the current `$USER`, `$REPO_DIR`, `$CC_HOME` and the absolute path to the active `node` binary, then installs it to `/etc/systemd/system/cc.service`
- sets up logrotate at `/etc/logrotate.d/cc`

Then provide credentials — either a `postline.config.ts` in the repo root, or the legacy env file `~/.cc/env` (600 perms):

```
CC_FEISHU_APP_ID=cli_xxxx
CC_FEISHU_APP_SECRET=xxxx
CC_FEISHU_BOT_OPEN_ID=ou_xxxx       # optional
CC_ALLOWLIST_OPEN_IDS=ou_xxxx,ou_yyyy
AWS_REGION=us-west-2                 # for bedrock
CC_PRIMARY_MODEL=amazon-bedrock/us.anthropic.claude-opus-4-7
CC_FALLBACK_MODELS=amazon-bedrock/global.anthropic.claude-sonnet-4-6,amazon-bedrock/us.anthropic.claude-opus-4-6-v1
CC_MEMORY_DIR=/home/<USER>/.cc/memory
CC_LOG_LEVEL=info
```

Enable + start:

```bash
sudo systemctl enable --now cc.service
journalctl -u cc -f
```

## Upgrade

```bash
~/postline/deploy/scripts/upgrade.sh
# Or, to force a rebuild+restart at the same sha:
FORCE=1 ~/postline/deploy/scripts/upgrade.sh
```

The memory pull cron runs every 5 minutes independently.

## Pushing from a laptop that blocks external pushes

If your workstation has a pre-push guardrail that refuses `github.com/<you>/postline` (corp devices, Code Defender, etc.), you can bundle unpushed commits and let the EC2 host do the push. It already has `gh auth` configured against the repo.

```bash
# from the laptop, inside the postline checkout:
deploy/scripts/push-via-ec2.sh                  # push what's ahead of upstream
deploy/scripts/push-via-ec2.sh --tag v0.1.8     # also create + push a tag

# Override defaults if your EC2 is elsewhere:
EC2_INSTANCE_ID=i-xxxx EC2_REGION=eu-central-1 \
EC2_REPO_DIR=/opt/postline EC2_USER=postline \
deploy/scripts/push-via-ec2.sh
```

The script packs `@{upstream}..HEAD` as a git bundle, uploads it via `ssm send-command` (base64-inlined, no S3 round-trip), fetches it on EC2, pushes to `origin/<current-branch>`, optionally tags and pushes the tag, then fast-forwards the local upstream ref. Requires AWS creds with SSM `send-command` + `get-command-invocation` plus `jq` + `python3` on the laptop.

## Troubleshooting

- `systemctl status cc.service` — quick health
- `journalctl -u cc --since "10 min ago"` — structured logs (pino JSON)
- `cat ~/.cc/logs/memory-sync.log` — memory pull status
- Feishu connection lost → usually autorecovers (`autoReconnect: true` in WSClient). If not: restart the service.

## Security

- The `~/.cc/env` file must be 600-perm and owned by the service user. It contains your feishu app secret.
- If you used an env-based config, do not include secrets in the corresponding `postline.config.ts` — pull them from env at load time (`process.env.X`). See `postline.config.example.ts`.
- Do not run the installer as root. Run as the service user (`ubuntu` on EC2, or a dedicated `postline` user).
- Open ports: postline doesn't open any. Only feishu's outbound WebSocket (to `*.feishu.cn` or `*.larksuite.com` on port 443).

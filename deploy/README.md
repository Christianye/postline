# Deploy — EC2 systemd

Phase 1 target: one EC2 host (`i-XXXXXXXXXXXXXXXXX`, us-west-2), running alongside `openclaw.service`.

## Prerequisites

- Node 22+ installed for `ubuntu` user (nvm-managed is fine)
- `sudo` without password or via SSM
- SSH key in `~/.ssh` that can read/write `github.com:Christianye/claude-memory.git`
- Bedrock access via instance role (already granted to `openclaw-bedrock-OpenClawInstanceRole`)
- Optional: `gh auth login` if GitHub tools will be exercised

## Install

```
ssh ubuntu@<host>  # or SSM session
curl -sL https://raw.githubusercontent.com/Christianye/postline/main/deploy/scripts/install.sh | bash
```

Then create `~/.cc/env` (600 perms):

```
CC_FEISHU_APP_ID=cli_xxxx
CC_FEISHU_APP_SECRET=xxxx
CC_FEISHU_BOT_OPEN_ID=ou_xxxx
CC_ALLOWLIST_OPEN_IDS=ou_xxxx,ou_yyyy
AWS_REGION=us-west-2
CC_PRIMARY_MODEL=amazon-bedrock/us.anthropic.claude-opus-4-7
CC_FALLBACK_MODELS=amazon-bedrock/global.anthropic.claude-sonnet-4-6,amazon-bedrock/us.anthropic.claude-opus-4-6-v1,amazon-bedrock/global.anthropic.claude-haiku-4-5-20251001-v1:0
CC_MEMORY_DIR=/home/ubuntu/.cc/memory
CC_LOG_LEVEL=info
# Optional — enables openclaw_bridge tools for 3-way collab with 虾晃.
# CC_OPENCLAW_TOKEN=...
# CC_OPENCLAW_URL=ws://localhost:18789
# CC_OPENCLAW_SESSION=cc-collab
```

Enable:

```
sudo systemctl enable --now cc.service
journalctl -u cc -f
```

## Upgrade

```
/home/ubuntu/postline/deploy/scripts/upgrade.sh
```

The memory pull cron runs every 5 minutes independently.

## Troubleshooting

- `systemctl status cc.service` — quick health
- `journalctl -u cc --since "10 min ago"` — recent structured logs (pino JSON)
- `cat /home/ubuntu/.cc/logs/memory-sync.log` — memory pull status
- Feishu connection lost → usually autorecovers (`autoReconnect: true` in WSClient). If not: restart service.

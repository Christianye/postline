# example: full

A full-featured postline config mirroring the author's production EC2 deployment.

## What's enabled

- **Provider**: Bedrock with a 4-model fallback chain (opus-4-7 → sonnet-4-6 → opus-4-6 → haiku-4-5)
- **All 8 built-in tools** (skipping `openclaw_bridge` by default):
  - `echo`, `web_fetch` — read
  - `fs`, `memory`, `github` — read + write
  - `lark_docs` — read (docx, wiki, sheet, bitable, drive)
  - `bash_read` — read, auto-approved
  - `bash` — dangerous, requires `/approve`
- **Memory auto-push**: every `memory_write` runs `git add && commit && push`
- **Allowlist**: only listed open_ids can trigger write/dangerous tools
- **File-system access**: memory dir + `/tmp` + home projects (read only outside the last)
- **@-mention requirement**: groups need `@bot`, DMs always respond

## Prerequisites

- AWS credentials with Bedrock access (instance profile preferred in prod)
- `gh auth login` completed
- Memory directory exists as a git repo with a remote that your SSH key can push to
- Feishu app with the 10 scopes listed in the [top-level README](../../README.md)

## Setup

```bash
# From repo root
cp examples/full/postline.config.ts .

# Edit the copy:
#  - feishu.appId         your feishu app id
#  - allowlist.openIds    your feishu open_id (one per line)
#  - memory.dir           absolute path to your git-backed memory repo

export POSTLINE_FEISHU_APP_SECRET=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx

pnpm install
pnpm -r build
pnpm --filter @postline/cli run start
```

For 24/7 deployment with systemd, see [`deploy/README.md`](../../deploy/README.md).

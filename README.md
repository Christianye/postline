# postline

> A **Feishu/Lark bot framework** powered by Claude — built for Chinese dev teams who want an always-on LLM teammate in their group chats.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-blue)](./tsconfig.base.json)
[![Tests](https://img.shields.io/badge/tests-168%20green-brightgreen)](#development)

Turn your Feishu/Lark workspace into a Claude-powered coworking bench:

- Ping the bot in any chat — it replies with **Claude Opus / Sonnet / Haiku** (via Bedrock or Anthropic API)
- Attach screenshots — Claude Vision reads them
- Send long questions — replies auto-chunk at 4500 chars
- Drop a Feishu docx / sheet / wiki URL — the bot reads and summarises it
- Ask it to run `git log`, `systemctl status`, `pnpm list` — that's a direct shell, but only **read-only commands auto-approve** (mutations wait for `/approve`)
- Schedule proactive pushes — `postline ask` + `feishu_send` for daily reports, alerts, scheduled digests
- Memory is a git repo — your bot remembers across sessions and machines
- Runs 24/7 on a tiny VM via systemd

---

## What it looks like

Three representative moments:

- **Local REPL** — run `pnpm chat` and ask _"tell me the last 5 commits and what each changed"_. The bot calls `bash_read` with `git log --oneline -5`, then follows up with a short narrative summary. No feishu app required.
- **Feishu DM / group** — `@postline` in any chat: _"帮我看下这台机器的 hostname + uname + systemd 里 cc.service 状态"_. The bot answers with 3-4 bubbles: tool call preview, shell output, final summary. Auto-approved because `bash_read` is read-only tier.
- **Feishu docs reader** — paste a `docx / wiki / sheet` URL: _"这个文档讲了什么？给我 3 条总结"_. The bot calls `lark_doc_read`, returns a 3-bullet summary plus follow-up questions worth asking.

More scenarios (10 paste-ready prompts covering git log aggregation, PR triage via `web_fetch`, memory writes as ADRs, scheduled daily reports, cross-doc OKR correlation, and screenshot-based debugging) in [**docs/COOKBOOK.md**](docs/COOKBOOK.md).

---

## 5-minute quickstart

### 1. Create a Feishu app

At [open.feishu.cn](https://open.feishu.cn) → **Create self-built app**.

Enable these permissions:

```
事件订阅 (event subscription):
  ✓ 长连接接收事件 (long-connection mode; no webhook URL needed)
  ✓ im.message.receive_v1

权限管理 (scopes):
  ✓ im:message                    # receive + read user messages
  ✓ im:message:send_as_bot        # reply + feishu_send tool
  ✓ docx:document:readonly        # lark_doc_read for docx
  ✓ drive:drive:readonly          # lark_doc_list for drive folders + docx downloads
  ✓ wiki:wiki:readonly            # lark_doc_read for wiki URLs
  ✓ sheets:spreadsheet:readonly   # lark_doc_read for sheets
  ✓ bitable:app:readonly          # lark_doc_read for bitable (base)
  ✓ docs:doc:readonly             # lark_doc_search
```

Each scope maps to a specific API call in the code — enable only the ones corresponding to tools you plan to load. The list above covers the full `lark_docs` tool plus receive + reply + `feishu_send`. A minimal bot that only answers text messages needs just the first two (`im:message`, `im:message:send_as_bot`).

Grab **App ID** (`cli_xxx`) and **App Secret** (32 chars). Publish a version (self-built apps self-approve).

### 2. Install postline

```bash
git clone https://github.com/Christianye/postline.git
cd postline
pnpm install
pnpm -r build
```

Requirements: Node 22+, pnpm 11+, AWS credentials (for Bedrock) or an `ANTHROPIC_API_KEY`.

### 3. Configure

Copy the example config and fill in your values:

```bash
cp postline.config.example.ts postline.config.ts
```

Minimum edits:

```ts
export default defineConfig({
  provider: { name: 'anthropic' },   // or { name: 'bedrock', region: 'us-west-2' }
  model: 'anthropic/claude-opus-4-7',

  allowlist: { openIds: ['ou_xxxxxxx'] },  // your feishu open_id

  memory: { dir: `${process.env.HOME}/.postline/memory` },

  // Omit the `feishu` block to run `pnpm chat` without a feishu app.
  // Add it back once you're ready to serve the bot:
  // feishu: {
  //   appId: 'cli_xxxxxxxxxxxxxxxx',
  //   appSecret: process.env.POSTLINE_FEISHU_APP_SECRET ?? '',
  // },

  tools: {
    // Starter set (safe without feishu creds). Add `'lark_docs'` once you wire up the feishu block.
    builtin: ['echo', 'web_fetch', 'fs', 'memory', 'github', 'bash_read', 'bash'],
  },
});
```

Set the needed env vars:

```bash
export ANTHROPIC_API_KEY=sk-ant-xxx                         # or configure AWS_REGION for Bedrock
export POSTLINE_FEISHU_APP_SECRET=xxxxxxxxxxxxxxxxxxxxxxxxx # only when the `feishu` block is enabled
```

### 4. Initialise memory

```bash
mkdir -p ~/.postline/memory
cd ~/.postline/memory
git init -b main
echo "# My postline memory" > MEMORY.md
git add -A && git commit -m "initial memory"
# Optionally: git remote add origin <your private repo> && git push
```

### 5. Run it

```bash
pnpm chat     # local REPL, no feishu needed
# OR
pnpm start    # connects to feishu and serves your bot
```

Both commands re-run `pnpm -r build` first so edits to config / tools pick up automatically.

DM the bot in Feishu. You should get a reply within a few seconds.

For 24/7 production, see [`deploy/README.md`](deploy/README.md) — ships a systemd unit + install/upgrade scripts.

---

## Upgrade & maintenance

postline is source-installed — no docker image, no npm publish. Upgrading is a `git pull + rebuild`:

```bash
pnpm run ship:upgrade         # fetch origin/main, preview incoming commits,
                              # stash local edits, fast-forward, pop the
                              # stash, re-install + re-build, restart
                              # cc.service if it's active on this host

pnpm run ship:upgrade -y      # same but skip the confirmation prompt
```

Other helpers:

```bash
pnpm doctor              # check node/pnpm/git versions, creds, config, memory dir
pnpm run ship:init       # scaffold postline.config.ts + ~/.postline/memory (idempotent)
```

> **Why `pnpm run ship:…`?** `pnpm upgrade` and `pnpm init` already mean something in pnpm itself. We keep our own maintenance commands under a `ship:` prefix so there's no ambiguity.

If you have local patches on top of main, `ship:upgrade` stashes them before pulling and restores them afterwards. A stash-pop conflict halts the upgrade with exit code 2 — your patches remain in `git stash list` until you resolve them manually.

For a cold-start on a fresh EC2/Hetzner host, see [`deploy/README.md`](deploy/README.md) — it installs pnpm, clones postline, renders the systemd unit, wires up logrotate + the memory-pull cron.

---

## What's inside

```
packages/
├── core/              # Interfaces: Provider, Channel, Tool, Memory + turn loop + redactor
├── providers/         # Bedrock (AWS) + Anthropic API + factory registry
├── adapters-feishu/   # Lark WebSocket long-connection + message split + image download
├── adapters-cli/      # stdin/stdout REPL for local dev
├── tools-builtin/     # 9 builtin tools (fs, memory, github, lark_docs, feishu_send, bash, bash_read, ...)
├── config/            # PostlineConfig type + defineConfig() + env fallback loader
└── cli/               # `postline chat | feishu | ask | upgrade | doctor | init`
```

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the interface seam diagram, and [`docs/THREAT_MODEL.md`](docs/THREAT_MODEL.md) for the 8-point security model.

---

## Built-in tools

| id | risk | what it does | example |
|---|---|---|---|
| `echo` | read | smoke-test only | — |
| `web_fetch` | read | HTTP GET a public URL; SSRF-guarded (RFC1918 / IMDS blocked), 2MB cap | [cookbook #4](docs/COOKBOOK.md#4-fetch--summarise-a-github-pr-page) |
| `fs` | read/write | `fs_read`, `fs_write`, `fs_edit` — path-allowlist gated | [cookbook #8](docs/COOKBOOK.md#8-read-a-local-config-file-and-explain-it) |
| `memory` | read/write | `memory_list`, `memory_read`, `memory_write` — auto `git commit && push` | [cookbook #5](docs/COOKBOOK.md#5-save-an-architecture-decision-to-memory) |
| `github` | read/write | `gh_query` (list/view/diff) auto-approved; `gh_action` (create/close/merge) requires approval | [cookbook #6](docs/COOKBOOK.md#6-list-unclosed-github-issues-by-label) |
| `lark_docs` | read | `lark_doc_read` / `list` / `search` — handles docx, wiki, sheet, bitable, drive folder/file, mammoth-extracts uploaded `.docx` attachments | [cookbook #3](docs/COOKBOOK.md#3-read-a-feishu-docx-and-summarise), [#9](docs/COOKBOOK.md#9-cross-reference-several-feishu-docs) |
| `feishu_send` | write | proactively send a text message to an allowlisted chat / user — used for daily reports, alerts, scheduled follow-ups | [cookbook #10](docs/COOKBOOK.md#10-scheduled-daily-report-with-postline-ask) |
| `bash_read` | read | shell commands whose tokens are all in a read-only allowlist (`ls`, `git log`, `systemctl status`, `node --version`, ...). Auto-approved. | [cookbook #1](docs/COOKBOOK.md#1-aggregate-recent-commits-by-author), [#2](docs/COOKBOOK.md#2-scan-the-repo-for-todo--fixme-with-owner-hints) |
| `bash` | dangerous | any shell command; **requires `/approve <id>` in feishu** | — |

Every tool is declared in `postline.config.ts` → `tools.builtin` and configured via `tools.options`. You can enable a subset.

See [`docs/TOOLS.md`](docs/TOOLS.md) for detailed per-tool configuration.

---

## Providers

- **Bedrock** (default): uses `@aws-sdk/client-bedrock-runtime`. Credentials via env / IMDS / AWS profile. Supports the full Claude 4.x lineup + graceful fallback chain.
- **Anthropic API**: uses `@anthropic-ai/sdk`. `ANTHROPIC_API_KEY` env.

Both support streaming, tool use, vision, and a fallback chain (`fallbacks: [...]` tries each in order on timeout/throttle).

Adding a new provider is a ~100-line file implementing `Provider` — see [`docs/PROVIDERS.md`](docs/PROVIDERS.md) and `packages/providers/src/bedrock/` as a template.

---

## Security model

postline is built for small-team / personal use, not untrusted multi-tenant. The core boundary:

- **Allowlist by `open_id`**: only listed users trigger `risk: write` or `risk: dangerous` tools. Others get read-only conversation.
- **Risk tiers**: every tool declares `read | write | dangerous`. Dangerous = user must reply `/approve <action_id>` within 5 minutes.
- **Secret redaction**: every reply is post-processed to strip AWS keys, GH tokens, PEM blocks, Bearer headers.
- **Prompt injection guard**: user text is wrapped `<user_message>…</user_message>` with a system-prompt rule that instructions inside the tags are untrusted data.

Read the full [THREAT_MODEL.md](docs/THREAT_MODEL.md). Report a vulnerability via [SECURITY.md](SECURITY.md).

---

## Development

```bash
pnpm install
pnpm -r build       # compile all packages
pnpm -r typecheck   # 0 errors expected
pnpm test           # 158 tests (vitest)
pnpm lint           # biome
```

[`CONTRIBUTING.md`](CONTRIBUTING.md) covers the commit format, testing expectations, and how to add a new provider / tool / channel.

---

## What this project is not

- **Not a Claude Code replacement**. postline is a thin always-on wrapper that exposes Claude (via whatever provider) into your IM. It doesn't have Claude Code's IDE features, plan mode, skills, subagents, or TodoWrite.
- **Not a universal agent framework**. It picks 4 interfaces and stops. If you need MCP clients, the loader is on the Phase 2b roadmap.
- **Not multi-tenant**. One deployment serves one person / team. RBAC = binary allowlist.
- **Not a Slack/Discord bot today**. `Channel` is an interface, but only Feishu/Lark is implemented. PRs welcome.

---

## Roadmap

- [x] Phase 1: 24/7 self-hosted deployment (EC2 + systemd). [Milestones M0–M5.](docs/ARCHITECTURE.md)
- [x] Phase 2a: config-driven, Anthropic provider, public repo
- [ ] Phase 2b: MCP client adapter (read `~/.claude/mcp.json`), Claude Code skill loader
- [ ] Phase 2c: community provider PRs (OpenRouter, Moonshot, 阿里云百炼, …)

---

## Credits

Built in the open with [Claude](https://claude.com). Not affiliated with Anthropic or ByteDance/Feishu.

---

## License

[MIT](LICENSE) — use it, fork it, ship your own variant.

# postline

> **The missing IM connector for Claude Code.** Add a Feishu / Lark / Telegram bot to your existing Claude Code sessions — chat to your agent from your phone, dispatch coding tasks remotely, get progress streamed back. postline carries bytes between the IM and your CC; the CC does the actual work.

> Feishu (飞书), known as **Lark** internationally, is ByteDance's workplace-messenger / docs suite — think Slack + Notion + Drive in one app. It's the default messenger for most Chinese product teams and many bilingual startups. If your team lives in Lark, postline lets your CC reach it too.

[![Feishu/Lark native](https://img.shields.io/badge/Feishu%2FLark-native-00D6B9)](https://www.larksuite.com)
[![Claude](https://img.shields.io/badge/Claude-Opus%2FSonnet%2FHaiku-d97757)](https://www.anthropic.com/claude)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-blue)](./tsconfig.base.json)
[![Tests](https://img.shields.io/badge/tests-passing-brightgreen)](#development)
[![Node](https://img.shields.io/badge/node-%3E%3D22-brightgreen)](./package.json)
[![CI](https://github.com/Christianye/postline/actions/workflows/ci.yml/badge.svg)](https://github.com/Christianye/postline/actions/workflows/ci.yml)

Wire up an IM bot for your Claude Code sessions:

- **Bridge mode by default** — postline holds **no LLM** of its own. It binds to a Feishu / Lark / Telegram bot, routes inbound messages to a CC worker registered for the relevant repo, streams the worker's reply back. Bring your own model on whichever host runs your CC.
- **Workers run anywhere CC runs** — Mac in iTerm2, EC2 over `tmux + ssm`, your home-lab box. The same `cc-worker` skill registers each one with postline by `(host, cwd)`. Multi-repo, multi-host, all dispatched from the same bot.
- **Repo-aware routing** — `routing.md` lives in your memory dir. Mention `postline` in Feishu and the message goes to the worker registered for the postline repo; no worker → reply with a hint, never a wrong answer from a different CC. Override prefixes (`!cc:repo`, `!cc:repo@host`) when you want to be explicit.
- **Progress streamed back into the same message** — postline edits one Feishu reply in place as the worker emits progress, ETA, tool calls, then the final result. No notification spam, no flipping back to your laptop.
- **Optional embedded LLM** — flip `embedded_llm.enabled = true` and postline keeps a Claude session for trivial queries that don't need a worker (greetings, "what time is it", quick translation). Off by default; many users won't want the bot holding their API key.
- **Proactive notifications** — bridge-side pollers can DM you on design-doc PR review activity (`notify.designReviewPush`), daily reports (`postline daily-report`), or anything else worth knowing without waiting for you to open GitHub.
- **Built-in security guardrails** — open_id allowlist, redactor for AWS / GitHub / Anthropic keys, prompt-injection wrapper around user input, in-chat `/approve <id>` for any tool the worker marks `dangerous`.
- **Ops-ready on day one** — `postline doctor --strict` for a real liveness probe, `postline tools` to see what each worker exposes, single-binary deploy via systemd or `docker compose`. Memory stays on each worker; postline carries no state besides routing rules + per-turn dedupe.

This README was co-authored by two long-running instances of the same Claude persona — different hosts, one shared git-backed memory. They review each other's PRs, disagree, and resolve it through a mailbox protocol that lives as a markdown file in their shared memory repo. If a Claude that persists across machines and turns into its own reviewer sounds like a useful primitive, the rest is how to host one.

### The 30-second demo

You want postline to review the diff you just pushed, but you're away from your Mac:

```
@cc !cc:postline review the latest commit on docs/readme-bridge-rewrite

📥 (Feishu reply, 3s later)
🟡 #a3f8 dispatched to mac (cwd=postline)
   ETA ~25s

🟡 #a3f8 running · reading commit · checking changeset...
🟢 #a3f8 done

# Review

The headline reads cleanly...
[full review text]
```

postline didn't run a model. The Mac CC you had open in iTerm2 picked up the task via `cc-worker`, ran the actual review with full repo context + tool access, streamed progress back. You read the answer on your phone.

---

## Why postline?

There are plenty of ways to wire an LLM into a chat tool. postline picks a narrow, specific spot — **the bridge between Claude Code and your IM**, nothing else:

- **Bridge first, agent never.** Most "AI bot" projects bake the model into the bot. We don't. The CC sessions you already have on your Mac / EC2 / wherever do the work; postline routes IM bytes to and from them. This means your repo context, your tool access, your `claude` CLI's full capability surface stays where it is — postline doesn't reimplement any of it.
- **`(repo, host)`-keyed routing, no LLM in the hot path.** A `routing.md` in your memory dir maps repo names + path tokens + override prefixes to specific workers. Postline's router is plain text matching — fast, debuggable, no API call to decide which worker handles a message.
- **Optional embedded LLM, off by default.** Flip `embedded_llm.enabled = true` and postline keeps a Claude session for the kinds of message that don't deserve a full CC roundtrip — greetings, "what's 12 USD in JPY", quick translation. Many users (especially self-hosters) won't want this; they get a pure bridge.
- **Feishu / Lark first.** Long-connection WebSocket, `@mention` parsing, image download, 4500-char split, in-place message editing, interactive approval cards — all first-class. Generic agent frameworks punt these to you. Telegram adapter is the next IM (PR-DB-6); Lark / Slack defer until users surface them.
- **Claude Code skills + MCP work transparently.** Workers are CC sessions. They already have your skills and your MCP servers loaded. postline never touches `~/.claude.json` or `~/.claude/skills/` — it just dispatches a task to the worker, and CC handles the rest like any local invocation.
- **Four interfaces, nothing more.** `Channel / Tool / Memory / Provider`. No plugin runtime, no DAG engine, no prompt DSL. Adding Telegram is one `Channel` implementation. The whole framework contract reads in 15 minutes.
- **Opinionated security.** Every tool a worker exposes declares `read | write | dangerous`. Write tools gated by `open_id` allowlist; dangerous tools require an in-chat `/approve` regardless of which worker hosts them. Outputs pass through a redactor for AWS / GitHub / Anthropic keys and PEM blocks. Prompt-injection guard wraps inbound IM content in `<user_message>…</user_message>` tags.
- **Ops-ready on day one.** `postline doctor --strict` checks the WS liveness tick the feishu adapter writes; `postline tools` lists what each worker exposes; `docker compose` and systemd flavours both ship. Memory lives on each worker, not on the bridge — easy to back up, easy to migrate, postline doesn't need its own data store.
- **Claude Code in your IDE, postline in your IM.** Same Claude, different surface. Compose them: write code in CC, `@cc !cc:postline review the diff` from your phone in standup, `@cc 总结今天合并的 PR` in the team chat. Different access pattern, same underlying agent.

  | What Claude Code does well | What postline adds |
  | --- | --- |
  | Lives in your IDE / terminal, one developer at a time | Lives in your IM, reach it from anywhere with phone reception |
  | Active when you run `claude` | Active 24/7 (the bridge); workers come online when CC opens |
  | Reads/writes your local repo | Routes the IM message to whichever CC has that repo open |
  | Plan mode, skills, subagents, TodoWrite | Adds `/approve <id>`, `routing.md`, IM message-edit progress UX |
  | Personal context window | Cross-CC dispatch — Mac CC and EC2 CC both reachable from the same bot |

If you want an open-ended agent framework, use LangChain or AutoGen. If you want a *bot host* that ships its own LLM, there are dozens. If you want to reach **the Claude Code session you already trust** from inside your IM, that's postline.

---

## 5-minute quickstart

### 1. Create a Feishu app

At [open.feishu.cn](https://open.feishu.cn) → **Create self-built app**.

Enable these permissions:

```
事件订阅 (event subscription):
  ✓ 长连接接收事件 (long-connection mode; no webhook URL needed)
  ✓ im.message.receive_v1           # user messages → the bot
  ✓ card.action.trigger             # clicks on the Approve/Deny card (optional but recommended)

权限管理 (scopes):
  ✓ im:message                    # receive + read user messages
  ✓ im:message:send_as_bot        # reply + feishu_send + interactive approval card
  ✓ docx:document:readonly        # lark_doc_read for docx
  ✓ drive:drive:readonly          # lark_doc_list for drive folders + docx downloads
  ✓ wiki:wiki:readonly            # lark_doc_read for wiki URLs
  ✓ sheets:spreadsheet:readonly   # lark_doc_read for sheets
  ✓ bitable:app:readonly          # lark_doc_read for bitable (base)
  ✓ docs:doc:readonly             # lark_doc_search
```

Each scope maps to a specific API call in the code — enable only the ones corresponding to tools you plan to load. The list above covers the full `lark_docs` tool plus receive + reply + `feishu_send` + the interactive approval card. `card.action.trigger` is optional — without it the bot still works, it just falls back to asking you to type `/approve <id>`. A minimal bot that only answers text messages needs just the first two (`im:message`, `im:message:send_as_bot`).

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
pnpm chat     # local REPL, no feishu needed (uses embedded LLM mode)
# OR
pnpm start    # connects to feishu and serves your bot
```

Both commands re-run `pnpm -r build` first so edits to config / tools pick up automatically.

DM the bot in Feishu. With `embedded_llm.enabled=true` you get a Claude reply within a few seconds. With it off (the default), the bot replies with a "no worker for this request" hint until you start a `cc-worker` skill on a host that has the right repo open — then dispatching works automatically.

For 24/7 production, see [`deploy/README.md`](deploy/README.md) — ships systemd unit + `docker compose` flavours.

---

## Upgrade & maintenance

postline is source-installed — no docker image, no npm publish. Upgrading is a `git pull + rebuild`:

```bash
pnpm run ship:upgrade         # fetch origin/main, preview incoming commits,
                              # stash local edits, fast-forward, pop the
                              # stash, re-install + re-build, restart
                              # the postline systemd unit if it's active

pnpm run ship:upgrade -y      # same but skip the confirmation prompt
```

Other helpers:

```bash
pnpm doctor              # check node/pnpm/git versions, creds, config, memory dir
pnpm run ship:init       # scaffold postline.config.ts + ~/.postline/memory (idempotent)
```

`pnpm doctor` is the first thing to run on a fresh install and whenever "the bot stopped responding" shows up. Sample output:

```text
[  ok] node        v22.14.0
[  ok] pnpm        11.0.8
[  ok] git         git version 2.50.1
[  ok] llm-creds   ANTHROPIC_API_KEY set (sk-ant-...XxXx)
[  ok] config      provider=anthropic, model=anthropic/claude-opus-4-7, tools=9 (postline.config.ts via workspace walk)
[  ok] memory-dir  ~/.postline/memory (git-backed, NN commits)
[  ok] feishu      appId cli_xxxx...xxxx resolves, long-connection reachable
```

Anything other than `[  ok]` gets a `[warn]` or `[fail]` prefix with a one-line hint — e.g. an empty memory dir warns to `git init`, an unreachable Bedrock endpoint tells you which env var is missing.

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
└── cli/               # `postline chat | feishu | ask | upgrade | doctor | init | tools`
```

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the interface seam diagram, and [`docs/THREAT_MODEL.md`](docs/THREAT_MODEL.md) for the 8-point security model. The longer "what is postline, why does it exist" page is [`ABOUT.md`](ABOUT.md).

---

## Built-in tools

| id | risk | what it does | example |
|---|---|---|---|
| `echo` | read | smoke-test only | — |
| `web_fetch` | read | HTTP GET a public URL; SSRF-guarded (RFC1918 / IMDS blocked), 2MB cap | [cookbook #4](docs/COOKBOOK.md#4-fetch--summarise-a-github-pr-page) |
| `fs` | read/write | `fs_read`, `fs_write`, `fs_edit` — path-allowlist gated | [cookbook #8](docs/COOKBOOK.md#8-read-a-local-config-file-and-explain-it) |
| `memory` | read/write | `memory_list`, `memory_read`, `memory_search`, `memory_write` — auto `git commit && push` | [cookbook #5](docs/COOKBOOK.md#5-save-an-architecture-decision-to-memory) |
| `github` | read/write | `gh_query` (list/view/diff) auto-approved; `gh_action` (create/close/merge) requires approval | [cookbook #6](docs/COOKBOOK.md#6-list-unclosed-github-issues-by-label) |
| `lark_docs` | read | `lark_doc_read` / `list` / `search` — handles docx, wiki, sheet, bitable, drive folder/file, mammoth-extracts uploaded `.docx` attachments | [cookbook #3](docs/COOKBOOK.md#3-read-a-feishu-docx-and-summarise), [#9](docs/COOKBOOK.md#9-cross-reference-several-feishu-docs) |
| `feishu_send` | write | proactively send a text message to an allowlisted chat / user — used for daily reports, alerts, scheduled follow-ups | [cookbook #10](docs/COOKBOOK.md#10-scheduled-daily-report-with-postline-ask) |
| `bash_read` | read | shell commands whose tokens are all in a read-only allowlist (`ls`, `git log`, `systemctl status`, `node --version`, ...). Auto-approved. | [cookbook #1](docs/COOKBOOK.md#1-aggregate-recent-commits-by-author), [#2](docs/COOKBOOK.md#2-scan-the-repo-for-todo--fixme-with-owner-hints) |
| `bash` | dangerous | any shell command; **requires `/approve <id>` in feishu** | — |
| `postline_stats` | read | self-reflection — `action: 'usage'` reports 24h token + USD; `action: 'health'` reports uptime, memory/history/usage state, pending approvals | — |
| `history_search` | read | grep across persisted conversation history (requires `cfg.history = { kind: 'fs' }`). Literal + regex, case-insensitive by default, optional `hours` window | — |

Plus two bridges (loaders, not single tools):

| bridge | risk | what it does | example |
|---|---|---|---|
| `mcp` | dangerous* | spawns stdio MCP servers at startup, exposes every server's tools as `mcp_<server>_<tool>`. Reads `~/.claude.json` → `mcpServers` by default, so any MCP server already registered with Claude Code / Claude Desktop works unchanged. | [`docs/TOOLS.md#mcp-model-context-protocol-client`](docs/TOOLS.md#mcp-model-context-protocol-client) |
| `skills` | read | walks `~/.claude/skills/`, exposes each `SKILL.md` as `skill_<id>`. Non-hidden skills are listed in the system prompt; the model picks one based on description. Same format as Claude Code — no duplication. | [`docs/TOOLS.md#claude-code-skills`](docs/TOOLS.md#claude-code-skills) |

*MCP default is `dangerous` (every call goes through `/approve`). Drop to `read` / `write` via `riskDefault` or `riskOverrides` if you trust the server.

Every tool is declared in `postline.config.ts` → `tools.builtin` and configured via `tools.options`. MCP servers live under `tools.mcp`, skills under `tools.skills`. You can enable a subset.

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

## In-chat approval flow — how `dangerous` tools actually run

The single most common concern for an always-on bot wired to `bash` is *"what stops the model from `rm -rf`-ing something?"* postline's answer is a per-call approval loop that lives in the chat itself — no web UI, no separate terminal to babysit:

1. **Model calls a `dangerous` tool.** Say it wants to run `git push --force`. The turn pauses.
2. **Bot posts an interactive approval card** to the same chat — header with the tool name, body with the args in a code block, and two buttons: **Approve** (primary) and **Deny** (danger). The card carries an 8-char action id and a footer reminding you of the text-fallback (`/approve <id>` / `/deny <id>`) in case card events aren't subscribed.
3. **You click Approve** (or Deny). The click fires `card.action.trigger`; the bot validates the clicker is on the `open_id` allowlist, then resolves the pending action. Non-allowlisted clickers get a red toast — *"You are not on the allowlist"*.
4. **Tool runs** (or doesn't), model resumes the turn with the tool result or a "denied by user" message.
5. **No decision in 5 minutes** → the pending action auto-denies and the model is told the user let it expire.

Fallbacks that work even without the feishu card-event subscription:

- Reply `/approve <id>` or `/deny <id>` in the same chat — the plain-text path is always active.
- If the card send itself fails (missing scope), the bot auto-downgrades to a plain-text prompt.

The registry is a tiny in-memory `Map<actionId, resolver>` (see [`packages/core/src/pending-actions.ts`](packages/core/src/pending-actions.ts)) — multiple pending actions can exist in parallel per chat, each with its own id. `pnpm chat` REPL uses the same registry (no cards in the terminal, just an inline `y` prompt), so approvals work identically there.

Tools default to `read` (no approval) or `write` (allowlist-gated, no per-call approval); only tools explicitly marked `dangerous` (currently `bash` and `gh_action`) route through this flow. Your own tools pick their tier at creation time.

---

## Memory — a git repo, not a vector database

Most Claude bots strap a vector store to the side and call that "memory". postline doesn't. A postline memory is a plain git repo full of markdown files:

```
~/.postline/memory/
├── MEMORY.md              # front-and-center index, always loaded into context
├── user_role.md           # who the operator is
├── project_postline.md    # what we're building
├── feedback_commit_style.md
└── reference_ec2_hosts.md
```

The `memory` tool exposes four operations: `memory_list`, `memory_read`, `memory_search` (literal or regex substring across every file), `memory_write`. On every write, postline does an auto `git add && git commit -m "<why>" && git push` against whatever remote you configured. That gives you three things for free:

- **Full audit trail.** Every update is a commit with a timestamp, an author, and a diff. `git log MEMORY.md` shows how your bot's understanding evolved.
- **Multi-host sync.** Mac + EC2 can share memory by pointing at the same private remote and running a 5-minute `git pull --rebase` cron on each host. The bot on your laptop and the bot in the group chat converge automatically.
- **Human editability.** You can edit memory from any text editor, push, and the bot picks it up on next turn. No re-embedding, no migration, no vendor.

**Why not embeddings?**

- **Audit.** A vector is a black box. `git blame MEMORY.md` is not.
- **Cost.** A git-backed memory is free to run; an embedding-backed memory locks you into an inference call per write + a vector DB per deployment.
- **Recall quality.** At the scale of one operator's notes (hundreds of files, not millions of docs), an always-loaded index + on-demand `memory_read` / `memory_search` beats vector top-k for the cases you actually hit. At *enterprise* scale you'd want vectors — postline isn't for that.
- **Reversibility.** `git revert` when the bot writes something wrong. Try reverting a vector upsert.

If you do want RAG, build it as a `Tool`. The core doesn't assume embedding-shaped memory, and nothing forces you to use the built-in `memory` tool.

---

## Development

```bash
pnpm install
pnpm -r build       # compile all packages
pnpm -r typecheck   # 0 errors expected
pnpm test           # vitest
pnpm lint           # biome
```

[`CONTRIBUTING.md`](CONTRIBUTING.md) covers the commit format, testing expectations, and how to add a new provider / tool / channel.

---

## What this project is not

- **Not a stand-alone agent**. By default postline holds no LLM. The work happens in your CC sessions; postline is the bridge.
- **Not a universal agent framework**. It picks 4 interfaces (`Channel / Tool / Memory / Provider`) and stops.
- **Not multi-tenant**. One deployment serves one operator. RBAC = open_id allowlist.
- **Not a Slack / Discord bot today**. `Channel` is an interface; Feishu / Lark is the v1 adapter, Telegram lands in PR-DB-6, others wait until users surface them.
- **Not a drop-in for an arbitrary LLM** (when embedded LLM is enabled). Claude is the deliberate choice — community provider PRs welcome only if they preserve streaming, tool use, and vision.

The full non-goals list (no vector DB, no web UI, no Redis/Kafka, no plugin runtime, no auto-update-on-main) lives in [docs/ROADMAP.md](docs/ROADMAP.md#non-goals).

---

## Roadmap

postline is at **0.4.0** and pivoting to a **bridge-first** product shape (v0.5.0). Phase 1 (24/7 self-hosted), 2a (open-source), 2b (MCP + skills) are done; the **Doorbell sprint** is in flight (`docs/SPRINT_PLAN_DOORBELL.md`):

- **PR-DB-0** ✅ (merged) — design-review push poller. Bridge DMs the operator on every new comment to a `docs/designs/*.md` PR.
- **PR-DB-1** — postline endpoints + queue + HMAC. The HTTP surface workers register against.
- **PR-DB-2** — router + dispatch flow with `routing.md` + `embedded_llm` toggle.
- **PR-DB-3** — `cc-worker` skill: workers run on any CC host (mac, ec2, anywhere).
- **PR-DB-4** — ETA + progress UX + status / workers query.
- **PR-DB-5** — `embedded_llm.enabled` opt-in (LLM-mode opt-back-in for users who want it).
- **PR-DB-6** — Telegram adapter.

Recent ship history:

- **0.4.0** — prompt caching on system prompt + tool array, per-turn model routing (haiku / opus split), `postline daily-report` subcommand + systemd timer
- **0.3.0** — extended thinking (adaptive) with live `💭 …` placeholder, `postline_stats action='history_audit'`
- **0.2.0** — keep-alive status events, HTTP retry with exponential backoff, in-process metrics, requester-only approval by default
- **0.1.10** — orphan `tool_use` no longer poisons history; approval card swaps to a resolved state on click

Full sprint plan + non-goals: [docs/SPRINT_PLAN_DOORBELL.md](docs/SPRINT_PLAN_DOORBELL.md), [docs/designs/postline-reframe.md](docs/designs/postline-reframe.md), [docs/ROADMAP.md](docs/ROADMAP.md).

Trying to decide if postline fits your use case? [docs/FAQ.md](docs/FAQ.md) and [docs/COMPARISON.md](docs/COMPARISON.md) answer most of the common questions.

---

## Community

- **Questions / show & tell** → [Discussions](https://github.com/Christianye/postline/discussions)
- **Bugs / feature requests** → [Issues](https://github.com/Christianye/postline/issues)
- **Security reports** → [private advisory](https://github.com/Christianye/postline/security/advisories/new) (see [SECURITY.md](SECURITY.md))
- **Conduct** → [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)

---

## Credits

Built in the open with [Claude](https://claude.com). Not affiliated with Anthropic or ByteDance/Feishu.

---

## License

[MIT](LICENSE) — use it, fork it, ship your own variant.

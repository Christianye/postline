# Cookbook — 10 recipes for what postline actually does

Each recipe is a full prompt + the tools it will touch + the shape of the output you'd see back in the chat. Paste them into `pnpm chat` or DM them to your bot.

> **Note (post-reframe):** these recipes drive postline's *embedded-LLM* path — the bot answering directly with its builtin tools. That path is **off by default** since the bridge reframe; enable it with `embedded_llm.enabled = true` in `postline.config.ts`. With it off, postline dispatches repo-scoped requests to a `cc-worker` instead (see the README quickstart). Model ids in the examples are illustrative — use whatever your config pins.
>
> The output blocks below are trimmed. Real replies include the assistant's reasoning and may be longer.

---

## 1. Aggregate recent commits by author

**Prompt**:
```
从 main 最近 7 天的 git log 里按作者聚合提交数量，顺带列每个人最典型的一条 commit subject
```

**Tools touched**: `bash_read` (one `git log --since='7 days ago' --pretty=...`)

**Output shape**:
```
Last 7 days on main (14 commits):
  Alice (5):   "feat(auth): add session rotation"
  Bob (4):     "fix(ingest): retry on 5xx from upstream"
  Claire (3):  "docs: threat model 8-point summary"
  Dave (2):    "chore: bump biome to 1.9.4"
```

**Why it matters**: retro prep without opening a terminal.

---

## 2. Scan the repo for TODO / FIXME with owner hints

**Prompt**:
```
grep 一下 packages/ 下面所有 TODO / FIXME / XXX，如果后面有 @name 也显示出来
```

**Tools touched**: `bash_read` (one `rg -n -o 'TODO|FIXME|XXX.*' packages/`)

**Output shape**:
```
12 matches across 8 files:
  packages/core/src/turn.ts:89    TODO @christian: revisit allowlist for channel=cli
  packages/providers/src/bedrock/index.ts:72   FIXME: widen fallback chain
  ...
```

**Why it matters**: one call, whole-repo hygiene check.

---

## 3. Read a Feishu docx and summarise

**Prompt**:
```
读 https://xxx.feishu.cn/docx/xxxxxxxxxxxxxxxxx 并用 5 条要点总结，最后列 3 个我应该追问的问题
```

**Tools touched**: `lark_docs` → `lark_doc_read`

**Output shape**:
```
Summary (5 bullets):
  - The spec targets Q3 launch of a new onboarding flow...
  - Two open questions around Vietnamese handset coverage...
  - ...

Follow-up questions:
  1. Is the KYC vendor contract signed for all four markets?
  2. ...
```

**Why it matters**: huge design docs → scanable brief in 10 seconds.

---

## 4. Fetch + summarise a GitHub PR page

**Prompt**:
```
用 web_fetch 读 https://github.com/someorg/somerepo/pull/1234，告诉我这个 PR 改了什么、review 里有没有 blocker
```

**Tools touched**: `web_fetch`

**Output shape**:
```
PR #1234: "Refactor ingest retry to exponential backoff"

What changed:
  - replaced linear `retryMs: n * attempt` with `Math.min(maxMs, baseMs * 2 ** attempt)`
  - added 4 new unit tests in ingest.test.ts

Blockers in review:
  - @reviewer1 requested: add jitter (unresolved)
  - @reviewer2 approved
```

**Why it matters**: triage PRs from a group chat before opening the tab.

---

## 5. Save an architecture decision to memory

**Prompt**:
```
把这个决定记到 memory：我们决定用 pino 做 structured logging 而不是 winston，原因是 pino 零 deps、async 写入。标签是 'adr, logging'
```

**Tools touched**: `memory_write` (with git auto-commit if `gitPush: true`)

**Output shape**:
```
saved to ~/.postline/memory/adr-logging-pino.md
commit: 4f2a1e9 "add logging ADR"
```

**Why it matters**: decisions survive across sessions, machines, and your own forgetfulness. Query later with `memory_list` or `memory_read`.

---

## 6. List unclosed GitHub issues by label

**Prompt**:
```
用 gh_query 列 Christianye/postline 所有 open 的 issue，按 label=bug / label=enhancement / 没 label 分三组
```

**Tools touched**: `gh_query` (one `gh issue list --repo ... --state open --json ...`)

**Output shape**:
```
open issues (7 total):

bugs (2):
  #12  "feishu reconnect loop after DNS flap"
  #19  "bash_read rejects valid rg invocation"

enhancements (3):
  #4   "MCP client adapter"
  ...

no label (2):
  #22  "Add Slack channel"
  ...
```

**Why it matters**: grooming view without GitHub UI.

---

## 7. Explain a screenshot of an error

**Prompt**: drop a screenshot of a terminal error / stacktrace into the feishu DM with the text:
```
这是我刚跑 pnpm build 的截图，帮我看看哪出错了
```

**Tools touched**: none (direct vision model input; Claude Vision reads the image)

**Output shape**:
```
The error is at packages/providers/src/bedrock/index.ts:48:

  TS2345: Argument of type 'ConverseStreamCommand' is not assignable to parameter of type 'Command<...>'.

Root cause: @aws-sdk/client-bedrock-runtime was bumped to 3.800 but you
haven't re-run pnpm install since. Try `pnpm install` and rebuild.
```

**Why it matters**: no need to re-paste stack traces as text, just screenshot.

---

## 8. Read a local config file and explain it

**Prompt**:
```
fs_read 一下 /etc/nginx/sites-available/default，告诉我这个 server block 做了什么
```

**Tools touched**: `fs_read` (path must be in `fs.readAllow`)

**Output shape**:
```
/etc/nginx/sites-available/default:
  - listens on :80 and :443 (ssl on)
  - root /var/www/html, fallback to index.html
  - proxies /api/ to http://127.0.0.1:3000 with 30s read timeout
  - adds `Strict-Transport-Security` with 1y max-age

No obvious issues; the X-Forwarded-For header is passed through as expected.
```

**Why it matters**: ops reading without ssh'ing + vim'ing.

---

## 9. Cross-reference several Feishu docs

**Prompt**:
```
lark_doc_search 搜 '2026 Q1 OKR'，取前 5 篇 docx 都读一遍，告诉我 launch 相关的 OKR 有哪些是 cross-team 依赖
```

**Tools touched**: `lark_doc_search` → `lark_doc_read` × 5

**Output shape**:
```
Cross-team dependencies found in 3 of 5 docs:

  Marketing ↔ Product:
    - "Launch campaign creative review" (owner: Alice, blocks product OKR #3)

  Product ↔ Infra:
    - "p99 latency target 200ms → requires cache warm-up work from infra"
    - "..."

Not cross-team: 4 items (listed below)
```

**Why it matters**: killer scenario for `lark_docs` — aggregating knowledge that's actually in 5 different places.

---

## 10. Scheduled daily report with `postline ask`

**Setup** (one-time): copy `examples/daily-report/` into your repo and customise the chat_id. See [`examples/daily-report/README.md`](../examples/daily-report/README.md).

**What you run** (from cron):
```bash
bash examples/daily-report/daily-report.sh
```

**What happens**:
1. `postline ask` runs a single turn with a prompt asking for a 24h GitHub digest
2. The model calls `gh_query` twice, composes a Chinese summary
3. It calls `feishu_send(chat_id='oc_xxx', text='...')` — the message lands in your status group
4. stdout gets the summary echoed for your cron log

**Output (in the feishu group)**:
```
📊 Postline daily (2026-05-11)

Merged (3):
  #102 feat(tools): feishu_send for proactive notifications — @christian
  ...

Open issues (1):
  #56  feishu long-connection reconnect hangs on DNS flap
```

**Why it matters**: same bot, proactive instead of reactive. This is the thing you can't do with a Claude Code terminal session.

---

## 11. Review a PR's diff by ref range

**Prompt**:
```
这是个 PR 合并前的 review 请求：对比 main..HEAD 的 diff，告诉我有没有明显的安全/正确性问题，再列 3 个值得测试的 edge case
```

**Tools touched**: `skill_review` (system-prompt advertised skill invoked by name), then `bash_read` for `git log main..HEAD --oneline` + `git diff main..HEAD --stat` + `git diff main..HEAD -- <file>` drilling into the biggest files.

**Output shape**:
```
Running skill_review. Range main..HEAD, 7 commits / 14 files changed.

Security 🔒
  - packages/tools-builtin/src/lark-docs.ts line 92: docx URL is stringified
    into a template literal before being passed to the lark API. Audit for
    upstream validation — if the `docToken` field isn't sanitised, an
    attacker-controlled URL could slip through.

Correctness ⚠️
  - packages/core/src/turn.ts: `usage` is captured but not propagated to the
    iter > 0 tool loop, so cost reporting under-counts multi-turn chains.

Edge cases worth testing
  1. memory_search on a 0-byte MEMORY.md → should return "(empty)" not crash
  2. skill with frontmatter but no body → adapter should still render header
  3. mcp HTTP server returning 401 on initialize — is the fail-open path
     covered by a test?
```

**Why it matters**: the `bash_read` allowlist already passes `git diff <ref>..<ref>` / `git show <ref>:<path>` — with `skill_review` (or any skill that walks through a review checklist) attached, the bot becomes a PR reviewer in the chat itself. No Claude Code session, no IDE plugin; just `@postline` in the group.

---

## Patterns worth noticing

- **Read-only tools auto-approve** (risk: `read`) — `bash_read`, `gh_query`, `lark_docs`, `fs_read`, `web_fetch`, `memory_*`. Anyone in the chat can invoke these.
- **Write tools require allowlist** (risk: `write`) — `fs_write`, `fs_edit`, `memory_write`, `gh_action`, `feishu_send`. Only `allowlist.openIds` users trigger them.
- **Dangerous tools require `/approve <id>`** (risk: `dangerous`) — full `bash`. Approval times out after 5 minutes.
- **Images go through as inputs** — drop a screenshot, Claude Vision handles it, no explicit tool call needed.
- **Memory is just markdown in a git repo** — any recipe that says "remember X" means `memory_write` + auto commit. Retrieval is grep or explicit `memory_read`.

See [`docs/TOOLS.md`](./TOOLS.md) for per-tool config and [`docs/THREAT_MODEL.md`](./THREAT_MODEL.md) for the guard rails behind this risk tiering.

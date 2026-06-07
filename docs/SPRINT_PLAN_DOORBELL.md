# Doorbell Sprint Plan (v2)

> Status: **Frozen for PR-DB-0 start · 2026-06-07** · Tracks 6 PRs implementing Doorbell + reframe.
> **Design source of truth**:
> - `docs/designs/doorbell.md` v3 (frozen 2026-06-07) — protocol spec
> - `docs/designs/postline-reframe.md` v2 (frozen 2026-06-07) — positioning + new PRs
>
> Where the two conflict, postline-reframe.md wins (e.g., default routing, worker skill name, embedded LLM toggle).
> v2 changes vs v1: ec2 CC stood down 2026-06-07; mac CC sole-owner. mac-worker → cc-worker. PR-DB-5 + PR-DB-6 added. (a) Feishu push hook adopted as PR-DB-0 (precedes everything because it makes review feedback visible). Total scope ~14d single-owner.

---

## Overview

Doorbell = postline ↔ CC remote interface (story chapter 3 · 总机, post-reframe).
postline-the-bridge dispatches IM-routed tasks to a CC worker registered for the relevant repo. Workers run on any host (mac, ec2 via tmux+SSM, anywhere). Progress streams back into the same Feishu message in place.

| Field | Value |
|---|---|
| **Total scope** | ~14 working days |
| **PR count** | 6 |
| **Owner** | mac CC (sole; ec2 stood down 2026-06-07) |
| **Concurrency** | Sequential. Single owner means parallelism gives no speedup. |
| **Design freeze** | doorbell.md v3 (2026-06-07) + postline-reframe.md v2 (2026-06-07) |
| **Transport** | AWS SSM port forwarding (`AWS-StartPortForwardingSession`); `127.0.0.1:9999` on EC2 only. See doorbell.md §6.1. |
| **Default behaviour** | No embedded LLM. No-match routing → reply with worker hint. Toggle in config to opt into LLM mode. |

## Dependency graph

```
   ┌──────────────────────────────────┐
   │  PR-DB-0 · (a) Feishu push hook  │
   │  meta-tooling, ship first        │
   └─────────────┬────────────────────┘
                 │
                 ▼
   ┌──────────────────────────────────┐
   │  Story doc rewrite + README PRs  │  parallelable docs work
   │  (project_postline_story.md +    │
   │   README.md) — separate PRs      │
   └─────────────┬────────────────────┘
                 │
                 ▼
   ┌──────────────────────────────────┐
   │  PR-DB-1 · postline endpoints +  │
   │  queue + HMAC                    │
   └─────────────┬────────────────────┘
                 │
                 ▼
   ┌──────────────────────────────────┐
   │  PR-DB-2 · router + dispatch     │
   │  flow (reframe-revised default)  │
   └─────────────┬────────────────────┘
                 │
                 ▼
   ┌──────────────────────────────────┐
   │  PR-DB-3 · cc-worker skill +     │
   │  headless runner                 │
   └─────────────┬────────────────────┘
                 │
                 ▼
   ┌──────────────────────────────────┐
   │  PR-DB-4 · ETA + progress UX +   │
   │  status / workers query          │
   └─────────────┬────────────────────┘
                 │
                 ▼
   ┌──────────────────────────────────┐
   │  PR-DB-5 · embedded_llm toggle   │
   └─────────────┬────────────────────┘
                 │
                 ▼
   ┌──────────────────────────────────┐
   │  PR-DB-6 · telegram adapter      │
   └──────────────────────────────────┘
```

---

## PR-DB-0 · Feishu design-review push hook

- **Owner**: mac CC
- **Size**: ~3h
- **Branch**: `feat/doorbell-pr0-design-review-push`
- **Why first**: meta-tooling. Once shipped, every subsequent design-doc review fires a Feishu push to the operator (per `protocol_cc_mailbox.md` "Design-doc review push to the operator" section). Lets us iterate on PR-DB-1..6 reviews without the operator manually checking GitHub.

### Scope

- New module: `packages/postline-core/src/notify/design-review-push.ts`.
- Detector: a turn-end hook that fires when (a) the turn made a `gh pr comment` call AND (b) the comment touched a path matching `docs/designs/*.md` OR PR title contains `design`/`RFC`.
- Self-dedupe: state file at `~/.postline/state/design-review-pushed.json`. One push per (PR, review-round-id).
- D1/D2 locked by mac CC: text format (not interactive card), single-receiver via `feishu_send` builtin.
- Message format:
  - `📋 <doc-name> review 完成 · <findings-summary> · <next-step>. → PR #<N>`
  - Receiver: the operator open_id (config `notify.designReviewPush.receiverOpenId`).
- Disable toggle: `notify.designReviewPush.enabled` (default true on EC2 deploy, false in tests).

### Acceptance

- Unit test: detector matches paths under `docs/designs/`, doesn't match `docs/SPRINT_PLAN_*.md` or `docs/COOKBOOK.md`.
- Unit test: state-file dedupe — same (PR, round-id) twice → second is no-op.
- Integration: trigger on a fixture PR comment touching `docs/designs/test-fixture.md`, observe a single Feishu send to the configured receiver.
- Disable toggle: with `notify.designReviewPush.enabled=false`, no Feishu send fires.

---

## PR-DB-1 · postline endpoints + queue + task ID

- **Owner**: mac CC
- **Size**: ~3-4 days (single-owner; +1d vs ec2-doable estimate)
- **Branch**: `feat/doorbell-pr1-endpoints`

### Scope

- New package: `packages/doorbell/` — HTTP server, registry, queue, HMAC.
- Mounted into `cmd-feishu` start-up path. Binds `127.0.0.1:9999`.
- Endpoints: `/mac/register`, `/mac/poll`, `/mac/progress`, `/mac/result`. (Names retained for protocol compatibility despite reframe; not breaking.)
- Long-poll wire protocol per design §4.0 (200 task / 204 idle / 4xx errors).
- HMAC auth via `DOORBELL_SECRET` env var (60s timestamp window).
- Per-cwd FIFO queue, cap 10 (`config.doorbell.queueMax`). Single shared queue per cwd (D10).
- Heartbeat sweep timer (60s) — workers idle longer get unregistered.
- Standby promotion engine (D05): FIFO over standbys when active dies.
- Demote-on-hold-poll: when a worker is demoted while holding an open long-poll, postline closes that connection with HTTP 409 and structured body (M4).
- Task ↔ workerId lock: once a 200 dispatch response is fully written, the task stays bound to that workerId through demotion (M3).
- Audit log: pino structured log line on register / poll-from-new-hostname / 4xx-rejected. Feishu DM to the operator only on first-time-hostname-seen, deduped via `~/.postline/state/known-hostnames.json` (Q2).

### Acceptance

- Integration tests with a mock worker: register → long-poll → receive task → progress → result round-trip.
- Multi-session race test (N4): register W1, W2, W3, W4, W5 in order; assert W5 active, W1-W4 standby. Kill W5 → W1 promotes. Kill W1 → W2 promotes. Continue until empty.
- Heartbeat sweep test: register worker, suppress polls 65s, assert worker auto-removed and pending tasks reverted to "no-worker queue" state.
- Long-poll wire protocol test: 204 on 30s idle, 200+payload on queued task, 401 on bad HMAC, 403 on ts-skew, 409 on standby-poll.
- Queue-cap test: push 10 tasks, assert 11th gets HTTP 429 with body matching D07 spec; rejection does not consume a slot.
- Demote-on-hold-poll test (M4): W1 active with poll open, register W2 same cwd, assert W1's poll closes immediately with HTTP 409 + body `{status: "demoted", reason: "another_worker_registered_for_cwd", newActiveWorkerId: "W2"}`.
- Task ↔ workerId lock test (M3): W1 active, dispatch `#a3f8` to W1; while W1 running, register W2 (W1 demotes); W1 posts progress + result for `#a3f8`; assert postline accepts both POSTs and task ends `done` owned by W1; new tasks dispatched in this window go to W2.

---

## PR-DB-2 · router + dispatch flow (reframe-revised)

- **Owner**: mac CC
- **Size**: ~2 days
- **Branch**: `feat/doorbell-pr2-router`

### Scope (reframe deltas vs original Doorbell v3 spec)

- `packages/postline-core/src/router/` — parser + matcher.
- chokidar watch with **atomic-swap** debounced reload (D09): parse to new config object, validate, swap pointer; never serve a half-loaded config. Parse failure logs warning + Feishu DM (§7 last row), keeps previous valid config.
- Hook into the Feishu turn dispatcher BEFORE provider call.
- `dispatch_to_mac` path → calls `DoorbellClient` (real; no mock-client interface needed since concurrency with PR-DB-1 was a workaround for ec2 split, now obsolete), edits a Feishu seed message.
- **Reframe default behaviour**: when no rule matches AND `embedded_llm.enabled = false` (default): reply `🤔 No worker for this request. Try !cc:<repo> ... or start a CC worker for the relevant repo.` When `embedded_llm.enabled = true`: fall back to old `ec2_self_solve` / `ec2_direct_answer` paths.
- Override prefix parser: `!cc` / `!cc:<repo>` / `!cc:<repo>@<host>` / `!ec2` / `!plain`. (`!mac` retained as alias for `!cc:default-mac` for back-compat in the operator's flow; no other host shortcuts.)
- `cwd_aliases` → `worker_aliases`, key by `(repo, host)` tuple per reframe §3.2.
- Destructive-verb pre-routing refusal (§7 row 3): tasks containing `deploy`/`rm -rf`/`force push`/`drop` keywords are refused at routing if no active worker exists for the target cwd.

### Acceptance

- 30+ table-driven router tests covering precedence: override > project > path > toolchain > explicit-verbs > self-solve (when LLM mode) > direct-answer (when LLM mode) > fallback.
- Live `routing.md` reload test: chokidar edit → next message uses new rules without restart.
- Destructive-verb pre-routing refusal test: inject `deploy postline now` with no active worker; assert task is refused with explicit Feishu reply, **not queued**.
- Embedded LLM toggle: with `embedded_llm.enabled=false`, no-match → "no worker" hint reply; with `enabled=true`, no-match → ec2_self_solve path.

---

## PR-DB-3 · cc-worker skill + headless runner

- **Owner**: mac CC
- **Size**: ~2 days
- **Branch**: `feat/doorbell-pr3-cc-worker`
- **Renamed from** `mac-worker` per reframe RF3.

### Scope

- New skill `cc-worker` under `~/.claude/skills/cc-worker/` (host-agnostic; works on mac, ec2 via tmux+SSM, anywhere CC runs).
- Subcommands: `start`, `stop`, `status`.
- Worker process (small node script `cc-worker.js`):
  - reads `DOORBELL_SECRET` from env
  - canonicalises cwd per design §4.4 (git toplevel → realpath → POSIX-normalise; preserve case)
  - posts `/mac/register` with hostname, canonical cwd, pid
  - long-poll loop per design §4.0 (30s timeout, exponential reconnect backoff on errors / 5xx / network drop; 1s→2→5→10→30 cap)
  - on 200 task → spawn `claude -p <task>` with headless invariants below
  - stdout pipe → POST `/mac/progress` debounced 5s
  - on exit → POST `/mac/result`
- Status file: `~/.postline/state/cc-worker-<host>-<cwd-hash>.json` (pid, registered_at).
- SSM session supervisor: auto-restart on idle disconnect (per design §6.1 failure-mode mitigation). Only relevant when running on a host accessed via SSM (typically the EC2 ec2 CC).

### Headless invariants

- Same model as the active CC session (read from same `model:` config; never downgrade). Any divergence is a config bug.
- Same system prompt + same memory dir (inherits `~/.claude/memory/...`) so the headless task behaves like an interactive the operator↔CC turn.
- Same working-style ("先方案后代码 / dangerous 动作先声明 / 中文回复") pulled from memory.
- Headless prompt prepends a fixed preamble: "You are running headless on behalf of postline-the-bridge. If you predict total runtime > 30s, emit exactly `<eta>SECS</eta>` on a line by itself before any tool calls. Else emit nothing for the ETA tag."

### Acceptance

- Round-trip from `start` to receiving a real task to result on Feishu.
- Manual kill of `claude -p` (via `kill -TERM <pid>`) triggers `status:killed` to postline.
- Multi-session start (two `start` invocations same cwd) → second wins, first transitions standby; assert via `cc-worker status`.
- Headless invariants test: small fixture task verifies model id, system prompt prefix, and memory access in the spawned process.
- ec2 deployment test: SSM into EC2, tmux start `claude`, run `/cc-worker start`, dispatch a Feishu task with `!cc:postline@ec2`, observe round-trip.

---

## PR-DB-4 · ETA + progress UX + status / workers query

- **Owner**: mac CC
- **Size**: ~1 day
- **Branch**: `feat/doorbell-pr4-eta-progress`

### Scope

- Headless prompt template (per PR-DB-3 invariants) emits `<eta>SECS</eta>` only when >30s expected.
- **postline ETA parser is strict** (F14):
  - regex anchored: `^\s*<eta>(\d+)<\/eta>\s*$`
  - applies only to lines emitted **before any tool invocation** in the progress stream
  - inline matches (e.g. inside a code block) are ignored
  - reject and log warning if `SECS` is non-numeric or > 3600 (1h cap)
- Progress edits at most every 5s (Feishu rate limit guardrail).
- New builtin tool `doorbell_status` exposed as `@cc status #a3f8`. Lookup key is the Feishu message id (D04 duality); the 4-char id is a UX hint only.
- New builtin tool `doorbell_workers` exposed as `@cc workers`.

### Acceptance

- Live test: dispatch a 60s task, observe Feishu seed message edit through ETA → progress → done.
- `@cc workers` lists active + standby workers per cwd, ordered by activeness then registered_at.
- ETA parser unit tests: alone-on-line accepted, inline rejected, non-numeric rejected, >3600 rejected.
- Retry color rollback test (F9): force a `dropped` mid-task, assert Feishu edit goes 🟡→🟠→🟡 on re-pickup → 🟢 on done.

---

## PR-DB-5 · embedded LLM toggle

- **Owner**: mac CC
- **Size**: ~1 day
- **Branch**: `feat/doorbell-pr5-llm-toggle`

### Scope

- Config field `embedded_llm.enabled` (default `false`).
- When `true`: postline retains a Claude provider instance + memory access for `ec2_self_solve` / `ec2_direct_answer` routing paths (i.e., the original pre-reframe behaviour).
- When `false` (default): no Claude session in postline; no memory access; no `ec2_self_solve` / `ec2_direct_answer` execution.
- Config validation: when `embedded_llm.enabled=true`, require credentials present (via existing provider config); fail boot loudly with explicit error if missing.

### Acceptance

- Boot test: `embedded_llm.enabled=false` (default) — postline starts without Claude credentials in env, no startup errors.
- Boot test: `embedded_llm.enabled=true` without credentials → fails boot with explicit error.
- Routing test: with `embedded_llm.enabled=true`, no-match input → ec2_self_solve path executes.
- Routing test: with `embedded_llm.enabled=false`, no-match input → "no worker" hint reply; never tries to call Claude.

---

## PR-DB-6 · telegram adapter

- **Owner**: mac CC
- **Size**: ~2 days
- **Branch**: `feat/doorbell-pr6-telegram`

### Scope

- New package: `packages/adapters-telegram/` mirroring `@postline/adapters-feishu` interface.
- Bot API only (TDLib deferred to v2 per RFOQ4).
- `Channel` interface: `listen()`, `send()`, `editText()`. (No interactive cards in v1; Telegram's inline keyboard differs enough that mapping the approval-card flow is out of scope.)
- Worker-dispatch flow uses the same router + Doorbell as Feishu — adapter only handles inbound parsing and outbound message edits.
- Config field: `channel.telegram.botToken`, `channel.telegram.allowedChatIds`.

### Acceptance

- Integration: register a test bot with @BotFather, configure `botToken`, send a `!cc:postline 你好` message in a private chat, observe round-trip with progress edits.
- AllowList: messages from chatId not in `allowedChatIds` get silent-drop (no reply, audit log line).
- Long message split: per Telegram's 4096-char limit, messages over that get split into N replies (matches Feishu adapter's `splitForFeishu` semantics).

---

## Out of scope for v1 (deferred to v2 or never)

Carried over from doorbell.md §10 + reframe.md §10:

- Encrypted tunnel (HMAC over TLS is fine for v1).
- Multi-Mac / multi-EC2 worker sets (one worker per (repo, host) suffices for now).
- Web UI for status (replace `@cc workers` with a `/status` page).
- Persistent task queue across postline restarts (sqlite). Re-evaluate after measuring restart frequency.
- Cross-CC task chains (one CC dispatches sub-task back to another CC).
- Approval cards for dangerous mac tasks. Defer until threat model in design §6 is exercised.
- Lark / Slack adapters. Telegram is enough for v1.
- TDLib for Telegram (richer features); Bot API for v1.

## Open questions still outstanding

- (OQ1) HMAC + shared secret vs OIDC-style token per `/mac/register`. v1 ships shared-secret + 60s timestamp window.
- (OQ3) Per-Feishu-thread budget cap for `claude -p` headless cost. v1 = report-only via existing `usage.jsonl`.
- (RFOQ1) `cc.service` in-place upgrade vs new binary on v0.5.0 release. Lean: in-place. Mark BREAKING in changelog so the one operator (the operator) updates the env.
- (RFOQ2) Default-worker-per-repo persistence. Defer to v0.6.0.
- (RFOQ3) Keep `ec2_self_solve` / `ec2_direct_answer` syntactically in routing.md when embedded_llm off, or strip? Lean: keep, no-op when off.
- (RFOQ4) Telegram TDLib for richer auth. Defer to v2.

---

## Changelog

- **2026-06-07 · v2 · mac CC**: ec2 stand-down absorbed. Sole-owner. mac-worker → cc-worker. PR-DB-0 (Feishu push hook) added at top. PR-DB-5 (LLM toggle) + PR-DB-6 (telegram) appended. PR-DB-2 router default revised per reframe. Sequencing rewrite: ~14d single-owner.
- **2026-06-07 · v1 · Frozen**: extracted from `docs/designs/doorbell.md` §9 on Doorbell v3 freeze. No content changes vs the v3 design doc; this file was a stable reference for implementers without the rationale + tradeoffs noise.

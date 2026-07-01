# @postline/config

## 0.7.0

### Minor Changes

- fix: telegram/slack `approval` config (requesterOnly default true) via shared authorizeApproval (#76)

## 0.6.0

### Minor Changes

- 3a2a91f: feat(slack): `postline slack` bridge + extract shared IM bridge runner (PR-DB-7)

  Slack is now reachable end-to-end, and the telegram/slack turn loops are
  unified instead of duplicated.

  - **`im-bridge.ts`** — extracted the channel-agnostic IM bridge runner
    (config + provider/memory/tools assembly, own doorbell server, routing.md
    loader, turn loop, dispatch handling, `/approve` fallback, shutdown) from
    cmd-telegram. Parameterised by an `IMChannel` (structural `send` /
    `sendText` / `editText` / `listen` / `health`) + a per-channel
    `wireApproval` hook (the one place telegram callback_query vs slack
    block_actions diverge). PR-DB-7.
  - **`cmd-telegram.ts`** shrank from ~470 lines to wiring only; behaviour
    unchanged.
  - **`cmd-slack.ts`** + `postline slack` subcommand — Block Kit approval +
    slack allowlist, ~80 lines of wiring over the shared runner.
  - **Config** `slack?: { appToken?, botToken?, botUserId?, allowlist?,
requireMention?, apiBase? }`. `CC_SLACK_APP_TOKEN` + `CC_SLACK_BOT_TOKEN`
    env load it with no config file (parallel to feishu/telegram); env wins.

  **Feishu's card-approval path (cmd-feishu.ts) is deliberately untouched** —
  its richer surface (cards, DM, streaming, design-review poller) stays
  bespoke; only the two button-approval adapters share the runner. Zero
  regression risk to the live feishu bridge.

  712 tests pass.

- c3a0392: feat(telegram): `postline telegram` bridge — wire the Telegram adapter to the turn loop (PR-DB-6 part 2)

  Completes PR-DB-6. The Telegram adapter (#52) is now reachable end-to-end:

  - New `postline telegram` subcommand running an independent bridge daemon
    (own doorbell server + worker registry), mirroring `postline feishu`.
  - `cmd-telegram.ts` duplicates the channel-agnostic turn loop against
    `TelegramChannel` (D1 hybrid; shared `StreamingChannel` extraction is the
    deferred PR-DB-7).
  - Config: `telegram?: { botToken?, allowlist?, requireMention?, apiBase?,
streamingDebounceMs? }`. `CC_TELEGRAM_BOT_TOKEN` env loads it with no
    config file (parallel to `CC_FEISHU_*`); env wins over inline token.
  - Allowlist keys on numeric Telegram user ids (merged into the global
    allowlist). Inline-keyboard + `/approve <id>` approval both wired.
  - Wake-prefix routing, responder attribution, and stream-json progress all
    carry over unchanged (the narrow-waist payoff).

  Deferred vs feishu (documented in the design doc, not silently dropped):
  live-typing streaming edits, photo→turn ingestion, the design-review push
  poller. Run feishu and telegram as separate processes on distinct doorbell
  ports if you want both.

### Patch Changes

- Updated dependencies [d8791cb]
- Updated dependencies [5040a61]
  - @postline/core@0.6.0
  - @postline/mcp-client@0.5.1
  - @postline/providers@0.5.1
  - @postline/skill-loader@0.5.1

## 0.5.0

### Minor Changes

- b572ad1: feat(doorbell): PR-DB-1 — endpoints + queue + worker registry + HMAC + long-poll

  First substantive piece of the Doorbell sprint (`docs/SPRINT_PLAN_DOORBELL.md`).
  Adds a new `@postline/doorbell` package with the HTTP surface CC workers
  (cc-worker skill, lands in PR-DB-3) register against, plus the cli
  wiring to spawn the server on `runFeishu` start-up.

  What ships:

  - Protocol types (Worker, Task, TaskStatus, QueueFullError, DemotedError)
    matching `docs/designs/doorbell.md` v3.
  - HMAC sign/verify (sha256 over method+path+body+ts; 60s default skew
    window; constant-time compare). Tagged failure reasons map to 400 /
    401 / 403 wire status.
  - WorkerRegistry: per-cwd FIFO standby with latest-wins on registration.
    Hooks for onDemoted / onPromoted / onRemoved. `sweepStale(now,
thresholdMs)` returns the swept workers.
  - TaskQueue: per-cwd FIFO with hard cap (default 10). 11th request gets
    the structured QueueFullError shape; rejection does NOT consume a
    slot. Tasks bind to an owning workerId at dispatch (M3 lock) and
    stay bound through demotion. `releaseWorker(id)` reverts in-flight
    tasks to head-of-queue with retryCount++.
  - DoorbellCoordinator: ties registry × queue. Owns the heartbeat sweep
    timer (default 60s/60s). `enqueueAndMaybeDispatch` wakes parked
    long-polls. `subscribePoll` lets the HTTP server park a request and
    cancel on hangup. Demotion → 409. Promotion drains queue immediately.
  - DoorbellServer (HTTP, binds 127.0.0.1:9999 by default per §6.1).
    Endpoints: POST /mac/register, GET /mac/poll, POST /mac/progress,
    POST /mac/result. Long-poll holds up to 30s with wake on enqueue
    (200), demote (409), removal (401), or timeout (204). Audit-log every
    register / auth_rejected as structured pino. First-hostname-seen hook
    fires once per hostname per server lifetime.
  - @postline/config: new `doorbell` block (toggle / host / port / secret
    / queueMax / longPollTimeoutMs / hmacWindowMs / sweepIntervalMs /
    staleThresholdMs / auditFeishuReceiverOpenId).
  - @postline/adapters-feishu: new `FeishuChannel.sendDirectMessage` (DM
    by open_id) — used by the audit Feishu DM path.
  - @postline/cli: `runFeishu` now starts the doorbell server when the
    config block is enabled, and tears it down on SIGINT/SIGTERM.

  What's NOT in this PR (deliberately, comes later):

  - Router that decides which messages dispatch to the doorbell — that's
    PR-DB-2.
  - The `cc-worker` skill that registers against these endpoints — PR-DB-3.
  - ETA + progress UX + status query in Feishu — PR-DB-4.

  69 new tests in @postline/doorbell. Workspace 570/0 green.

- 1c3efa3: feat(router): PR-DB-2 — routing.md loader + matcher + Feishu dispatch flow

  Wires the doorbell from PR-DB-1 into the Feishu inbound path via a
  routing.md-driven router (design §8 + reframe §3.2). The bridge now:

  1. Loads `routing.md` from `<memory.dir>/routing.md` (or
     `cfg.router.routingMdPath`) on `runFeishu` startup.
  2. chokidar-watches the file with atomic-swap reload (D09): edits
     apply on the next inbound message without restart.
  3. For each inbound, runs `matchRoute(cfg, ...)` ahead of the local
     turn loop. The decision determines: - `dispatch_to_mac` → enqueue a task on the doorbell coordinator;
     reply with `🟡 dispatched to mac` (or `🟠 queued, no worker, will
be lost if postline restarts` when no active worker for the cwd). - `reject_no_worker` → reply with a hint to start a worker or
     enable embedded LLM. - `reject_destructive_no_worker` → reply with a refusal explaining
     why; never queue. - `ec2_self_solve` / `ec2_direct_answer` → fall through to the
     local turn loop (only useful when `embeddedLlm.enabled = true`).
  4. New override prefixes parsed in router: `!cc`, `!cc:<repo>`,
     `!cc:<repo>@<host>`, `!ec2`, `!plain`.

  Adds:

  - `@postline/core/router` — types, parser, matcher, chokidar loader.
    39 new router tests (8 parser + 25 matcher + 6 loader). chokidar 4.x
    added to @postline/core deps.
  - `@postline/config` — new `router` block (routingMdPath /
    reloadDebounceMs) and `embeddedLlm.enabled` toggle (default false,
    per RF1).
  - `@postline/cli` — `runFeishu` starts the routing loader, calls
    `matchRoute` before the turn loop, dispatches to the doorbell
    coordinator (PR-DB-1) on `dispatch_to_mac`, sends explicit Feishu
    reply on rejects. Routing loader closes on SIGINT/SIGTERM.

  What this enables (visible to the operator):

  - @cc-ing a Feishu chat with a `routing.md` rule that hits → the
    bridge replies in the chat with the dispatch / reject status. The
    task itself doesn't yet flow to a real CC because the worker side
    (`cc-worker` skill) lands in PR-DB-3. A mock worker via curl can
    exercise the round-trip today.
  - Any edit to `routing.md` takes effect on the next inbound, no
    restart needed.

  What's still missing (PR-DB-3 + later):

  - A real CC-worker skill that registers, long-polls, runs `claude -p`,
    posts progress + result. PR-DB-3.
  - ETA parser, in-place message-edit progress, status / workers
    query. PR-DB-4.
  - LLM toggle wiring on the turn loop side. PR-DB-5.

- d92d505: feat(notify): design-review push poller (PR-DB-0)

  Bridge-side proactive notification. When `notify.designReviewPush` is
  configured with `enabled: true`, the feishu daemon spawns a background
  poller that watches a GitHub repo for new comments on PRs touching
  `docs/designs/*.md` (configurable). On every fresh comment, postline
  DMs the operator with a one-line summary that includes the PR title,
  author, snippet of the comment, and a link.

  Why this matters in the reframed bridge: the operator no longer has to
  refresh GitHub manually to see whether design-doc reviews have arrived.
  Each push is deduped per `(PR, comment_id)` via a state file at
  `~/.postline/state/design-review-pushed.json` (or
  `$CC_STATE_DIR/...`).

  New exports:

  - `@postline/core`: `startDesignReviewPushPoller`, `isDesignReviewPr`,
    `formatPushMessage`; types `DesignReviewPushOptions`,
    `DesignReviewPushHandle`.
  - `@postline/adapters-feishu`: `FeishuChannel.sendDirectMessage(...)`
    for DM-by-open_id (used by the poller, also generally useful).
  - `@postline/config`: `notify.designReviewPush` block.

  The poller serializes ticks (kickoff + interval cannot overlap, so a
  slow `gh` call doesn't double-push). Errors during a tick are logged
  and the timer continues. `gh` is invoked through a swappable `ghJson`
  hook (default spawns from PATH), keeping tests offline.

### Patch Changes

- Updated dependencies [1c3efa3]
- Updated dependencies [d92d505]
  - @postline/core@0.5.0
  - @postline/mcp-client@0.4.1
  - @postline/providers@0.4.1
  - @postline/skill-loader@0.4.1

## 0.4.0

### Minor Changes

- 802ee1b: Add optional model-routing config that classifies inbound text per turn and routes trivial queries (greetings, short text under `trivialMaxChars`, no tool-trigger keywords) to a cheaper `smallModel` instead of the primary. ~10x cost saving for high-frequency trivial chat without affecting hard query quality.

  Off by default (no behaviour change unless you opt in).

  ```ts
  routing: {
    enabled: true,
    smallModel: 'amazon-bedrock/global.anthropic.claude-haiku-4-5-20251001-v1:0',  // default
    trivialMaxChars: 50,                                                            // default
  }
  ```

  Classifier is intentionally conservative: any English action verb (`run`, `check`, `explain`, `search`, `fetch`, `read`, ...), Chinese intent verb (`跑`, `查`, `帮`, `解释`, `怎么`, ...), shell / path / URL token (`sudo`, `git `, `/home/`, `https://`, `\`\`\``), or multi-line input vetoes trivial classification and falls back to the primary model. Tunable knobs deliberately limited so config drift doesn't surface bad routing decisions silently.

  Wiring: `@postline/cli`'s `cmd-feishu` calls `pickModel(cfg.model, inbound.text, cfg.routing)` per turn; emits `feishu_routing_small_model` log when the small model is picked. 14 unit tests cover trivial / non-trivial classification + routing config gating.

### Patch Changes

- Updated dependencies [68b1e5b]
- Updated dependencies [299d3de]
  - @postline/providers@0.4.0
  - @postline/core@0.4.0
  - @postline/mcp-client@0.3.1
  - @postline/skill-loader@0.3.1

## 0.3.0

### Minor Changes

- 02aaa89: Add opt-in extended-thinking (reasoning) support across providers, the turn loop, and the Feishu streaming surface. When enabled, the model emits a thinking block before its visible answer; postline streams thinking deltas live to the seed message but does NOT persist them — each turn's reasoning is independent (no signature roundtrip overhead, simpler multi-turn semantics).

  ## Config

  ```ts
  inference: {
    thinking: {
      enabled: true,
      budgetTokens: 4096,   // default 4096, min 1024
    },
  }
  ```

  Off by default. Costs `budgetTokens` of additional output budget per turn (in addition to `maxTokens`).

  ## Wiring

  - `@postline/core`: new `'thinking_delta'` `StreamChunk` variant carrying a `thinking` text field; new `TurnLoopConfig.onThinkingDelta` hook (mirrors `onTextDelta` shape — `{delta, accumulated, iter}`); new `TurnRequest.thinking` request field; `collectStream` accumulates thinking text per-iter (separate from assistant text) and forwards deltas to the hook.
  - `@postline/providers` (anthropic): passes `thinking: {type: 'enabled', budget_tokens}` to `messages.stream`; surfaces `content_block_delta` events with `delta.type === 'thinking_delta'` as `'thinking_delta'` chunks. `signature_delta` and other delta kinds are dropped (scope (c) doesn't echo thinking back in multi-turn).
  - `@postline/providers` (bedrock): passes `additionalModelRequestFields.thinking` (Bedrock Converse doesn't have a first-class thinking field); decodes `reasoningContent` deltas — only the `text` member is forwarded; `signature` / `redactedContent` members are ignored.
  - `@postline/adapters-feishu` `feishu-stream` (CLI): new `onThinkingDelta(accumulated)` method on `StreamingHandle`. Renders a rolling placeholder `💭 <last 200 chars>` in the seed message during silent windows; same gate as status events — once real assistant text streams in this iter, thinking is ignored. Whitespace is collapsed so the placeholder stays single-line. The CLI host wires `streamer.onThinkingDelta` from the new turn hook.

  ## Why "scope (c)"

  Per the design exploration, three options were considered:

  - (a) full roundtrip — keep thinking blocks + signatures in history so multi-turn reasoning chains are preserved (Anthropic's recommended pattern). Adds protocol complexity for minimal value in postline's single-turn-per-message use case.
  - (b) lite — count thinking tokens only, no UI visibility. Loses the debug value of seeing what the model is reasoning about.
  - (c) **chosen** — show thinking text live, drop on history boundary. Each turn's reasoning is independent; the user sees `💭 …` rolling text during silent windows, then the answer; the next turn starts fresh without any signature roundtrip overhead.

  ## Test plan

  8 new unit tests:

  - core: thinking_delta forwarded to hook with correct accumulated text; thinking does NOT enter persisted history; hook errors don't crash the turn
  - feishu-stream: 💭 prefix + rolling 200-char window + whitespace collapse; pre-text gate suppression; finish() override

### Patch Changes

- e8e1264: Fix extended-thinking protocol: switch from the old `thinking.type='enabled'` + `budget_tokens` shape to the new `thinking.type='adaptive'` + `output_config.effort` shape required by Claude Opus 4.7+.

  Background: PR #12 shipped extended-thinking using the manual-budget protocol, which Bedrock rejected on Opus 4.7 with `"thinking.type.enabled" is not supported for this model. Use "thinking.type.adaptive" and "output_config.effort"`. The model also fell through the entire fallback chain (sonnet-4-6, opus-4-6, haiku-4-5) returning the same error, so any turn with thinking enabled failed silently with `replyLen: 0`. Fix verified against the [Bedrock adaptive thinking docs](https://docs.aws.amazon.com/bedrock/latest/userguide/claude-messages-adaptive-thinking.html) and the Anthropic SDK `ThinkingConfigAdaptive` / `OutputConfig` types.

  API changes (all packages still pre-1.0, so patch):

  - `@postline/config` `inference.thinking`: `budgetTokens?: number` → `effort?: 'low' | 'medium' | 'high' | 'max'`. Default `'high'` (always think). Manual budget knob is gone — adaptive mode lets the model decide.
  - `@postline/core` `TurnRequest.thinking` and `TurnLoopConfig.thinking`: same shape change.
  - `@postline/providers` bedrock: sends `additionalModelRequestFields: { thinking: { type: 'adaptive' }, output_config: { effort } }` (effort is rejected if placed inside `thinking` — Bedrock requires it in a sibling `output_config`).
  - `@postline/providers` anthropic: top-level `thinking: { type: 'adaptive' }` + top-level `output_config: { effort }`. The installed `@anthropic-ai/sdk@^0.40.0` types still only know `'enabled' | 'disabled'`, so the field is cast through unknown until a future SDK bump.

  Both providers continue to surface thinking deltas as `'thinking_delta'` `StreamChunk`s; nothing on the consumer side (turn loop, feishu-stream) changes.

- Updated dependencies [02aaa89]
- Updated dependencies [e8e1264]
  - @postline/core@0.3.0
  - @postline/providers@0.3.0
  - @postline/mcp-client@0.2.1
  - @postline/skill-loader@0.2.1

## 0.2.0

### Minor Changes

- f254229: Restrict approval-card and `/approve` `/deny` slash-command resolution to the user who originally triggered the dangerous tool, with an optional admin-override list. Default is `requesterOnly: true` (a behaviour change in shared chats: bystanders who could previously approve any dangerous action on behalf of someone else now cannot).

  New `feishu.approval` config block:

  ```ts
  feishu: {
    approval: {
      requesterOnly: true,            // default — set false for legacy behaviour
      admins: ['ou_oncall_human'],    // override list, default []
    },
  }
  ```

  Behaviour:

  - `requesterOnly: true` + clicker is the original requester → allow
  - `requesterOnly: true` + clicker is in `admins` → allow + audit-log `feishu_approval_override` with `{actionId, requester, override_by, tool}`
  - `requesterOnly: true` + neither → toast `"Only the requester (or an admin) can resolve this action."`, audit-log `feishu_approval_rejected_not_requester`
  - `requesterOnly: false` → any allowlist member can resolve (legacy behaviour)

  Both card-button clicks and the `/approve <id>` / `/deny <id>` text fallback go through the same authorization function so the gate cannot be bypassed by typing the slash command.

  Validation: `feishu.approval.admins` must be an array of non-empty open_id strings.

### Patch Changes

- Updated dependencies [d7dadb1]
- Updated dependencies [377b80b]
- Updated dependencies [fcb8351]
  - @postline/core@0.2.0
  - @postline/providers@0.2.0
  - @postline/mcp-client@0.1.11
  - @postline/skill-loader@0.1.11

## 0.1.10

### Patch Changes

- Two fixes shipped together as 0.1.10:

  - **Prevent orphan `tool_use` blocks from poisoning conversation history.** When a stream errored or hit `max_tokens` after the assistant emitted a `tool_use` block, the turn loop persisted the assistant message but no matching `tool_result`, so subsequent turns reloaded a malformed `messages[0]` and the Anthropic API rejected with `Expected toolResult blocks at messages.0.content for the following Ids`. `@postline/core` now injects a synthetic `isError` `tool_result` on abort, and `@postline/cli` adds a `sanitizeHistory` pass on `load()` that drops orphan rows already on disk so existing polluted jsonl files heal automatically. (#1)
  - **Inline-swap the approval card on click.** Clicking Approve or Deny on a dangerous-tool approval card now atomically replaces the card with a resolved-state variant (green ✅ "Approved" / grey ❌ "Denied", no buttons, signed by clicker + timestamp). `buildApprovalCard` now sets `config.update_multi: true` (required for inline replacement), `CardActionResponse` gains an optional `card?: { type: 'raw'; data }` field, `buildResolvedCard` is newly exported from `@postline/adapters-feishu`, and `PendingActions` gains a `get(id)` accessor so adapters can read entry metadata before resolving. (#2)

- Updated dependencies
  - @postline/core@0.1.10
  - @postline/mcp-client@0.1.10
  - @postline/providers@0.1.10
  - @postline/skill-loader@0.1.10

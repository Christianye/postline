# @postline/adapters-feishu

## 0.6.0

### Patch Changes

- Updated dependencies [d8791cb]
- Updated dependencies [5040a61]
  - @postline/core@0.6.0

## 0.5.0

### Minor Changes

- 09df12d: feat(doctor): add `--strict` flag with feishu WS liveness probe

  `postline doctor --strict` now fails (exit 1) when the feishu adapter has
  not produced a liveness tick within 90s. The adapter writes a tick on
  every dispatched event and from a 30s keep-alive timer driven by the
  `Lark.WSClient` connection-state callbacks (`onReady`, `onReconnected`,
  paused on `onError`/`onReconnecting`). Missing tick is `warn` in lenient
  mode.

  The container Dockerfile and compose template both switch their
  HEALTHCHECK to `doctor --strict`, with `start_period: 120s` to absorb
  ws handshake time on cold boot. State dir defaults to `~/.postline/state`
  (host) or `/data/state` (container), overridable via `CC_STATE_DIR`.

  New exports from `@postline/adapters-feishu`:

  - `writeFeishuWsTick`, `readFeishuWsTick`
  - `resolveStateDir`, `resolveFeishuWsTickPath`
  - `FEISHU_WS_TICK_FILENAME`, `FeishuWsTick`

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

## 0.3.1

### Patch Changes

- Updated dependencies [299d3de]
  - @postline/core@0.4.0

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

- Updated dependencies [02aaa89]
- Updated dependencies [e8e1264]
  - @postline/core@0.3.0

## 0.2.0

### Minor Changes

- d1e91fe: Approval-card preview is now rendered per tool instead of as a single JSON blob:

  - `bash` / `bash_read` → command in a `bash` fenced code block; cwd and timeout as inline footnotes
  - `fs_write` → path inline + content size + content snippet (fenced)
  - `fs_edit` → path inline + old_string + new_string (each clamped to 200 chars)
  - `fs_read` → path inline
  - `web_fetch` → URL inline + optional Accept header
  - `feishu_send` → target chat_id + message text + mentions list
  - `gh_query` / `gh_action` → `gh ...` reconstructed in a `bash` fenced block
  - `skill_run` → skill id + script path + JSON-quoted argv + timeout
  - unknown tool name → fenced JSON fallback (covers MCP-spawned tools)

  Truncation is per-field with an explicit `[…N chars truncated]` suffix instead of the old silent `…` ellipsis, so reviewers can see when input was cut.

  **Breaking API change** (within `@postline/adapters-feishu`): `ApprovalCardParams.argsPreview: string` is replaced by `args: Record<string, unknown>` — the formatter renders inside `buildApprovalCard`. The only in-tree caller (`@postline/cli` / cmd-feishu) is updated; downstream consumers calling `buildApprovalCard` directly need to swap the field. Pre-1.0 patch bump per the workspace versioning policy.

  New export: `formatToolArgsPreview(toolName, args): { fields: PreviewField[] }` for reuse outside the card builder.

- d7dadb1: Add in-process metrics — counters and histograms for provider attempts, retries, fallbacks, turn outcomes, tool durations, and history sanitization. Surfaced through the existing `postline_stats` tool's new `metrics` action so the bot can report its own throttle / failover / orphan-recovery activity in chat without needing journalctl access.

  Counters declared:

  - `provider_attempt_total{provider, model, outcome}` — success / failure per model attempt
  - `provider_retry_total{provider, model}` — HTTP-level retries inside a single attempt (paired with the existing exponential-backoff retry)
  - `provider_fallback_total{provider, from_model, to_model}` — fallthroughs to the next model in the chain
  - `turn_total{outcome}` — completed turns, success or error
  - `tool_total{name, outcome}` — tool invocations, ok / error
  - `history_orphan_dropped_total{kind}` — orphan rows dropped during history sanitization

  Histograms declared (Prometheus-style cumulative buckets, default `[10, 50, 100, 250, 500, 1000, 2500, 5000, 10000, 30000, 60000, 120000]` ms):

  - `tool_duration_ms{name, outcome}`
  - `turn_duration_ms{outcome}`

  Wiring is opt-in via dependency injection: providers, the turn loop, and the history store all accept an optional `MetricsRegistry`. When omitted the code path is unchanged. The Feishu CLI command (`runFeishu`) instantiates `createPostlineMetrics()` and threads it through provider + history + turn + tool-build context. Tests for the CLI remain unaffected; turn / metrics / postline_stats tests cover the new paths.

  Public API additions on `@postline/core`:

  - `createMetricsRegistry(opts)` — generic factory for declared counters / histograms
  - `createPostlineMetrics()` — registry pre-loaded with the canonical postline metric set
  - `MetricsRegistry`, `MetricsSnapshot`, `CounterSnapshot`, `HistogramSnapshot`, `MetricLabels`, `DEFAULT_DURATION_BUCKETS_MS`, `POSTLINE_METRICS`

  `postline_stats` gains action `metrics` rendering a human-readable snapshot (counter totals + histogram count/avg/p50/p95 per series).

- 377b80b: Add synthetic keep-alive status events so the Feishu seed message no longer appears hung during silent windows (initial model connect, model thinking before first token, mid-turn between iterations, while a tool is running).

  - New `StreamStatus` type and `'status'` `StreamChunk` variant in `@postline/core` carry three kinds: `attempt_started` (provider opened a stream — `detail` = model id), `thinking` (stream open, no text yet), `tool_running` (`detail` = tool name). Heartbeats are synthetic — emitted by the host, not by the model — and don't affect token billing or model output.
  - `@postline/providers` (bedrock + anthropic) yield `attempt_started` when starting each model attempt and `thinking` once the stream is open but no content has arrived.
  - `@postline/core`'s turn runner emits `tool_running` immediately before invoking each tool, and exposes a new `onStatus` hook on `TurnLoopConfig` that adapters can use alongside `onTextDelta`.
  - The Feishu adapter (CLI) wires `onStatus` into `createStreamingMessage`: status placeholders ("Calling claude-opus-4-7…", "Thinking…", "Running tool: bash…") render in the seed message during silent windows but never overwrite real text once it streams in within the same iteration. New iteration boundaries (`attempt_started`, `tool_running`) reset the gate so the next status is visible.

### Patch Changes

- Updated dependencies [d7dadb1]
- Updated dependencies [377b80b]
  - @postline/core@0.2.0

## 0.1.10

### Patch Changes

- Two fixes shipped together as 0.1.10:

  - **Prevent orphan `tool_use` blocks from poisoning conversation history.** When a stream errored or hit `max_tokens` after the assistant emitted a `tool_use` block, the turn loop persisted the assistant message but no matching `tool_result`, so subsequent turns reloaded a malformed `messages[0]` and the Anthropic API rejected with `Expected toolResult blocks at messages.0.content for the following Ids`. `@postline/core` now injects a synthetic `isError` `tool_result` on abort, and `@postline/cli` adds a `sanitizeHistory` pass on `load()` that drops orphan rows already on disk so existing polluted jsonl files heal automatically. (#1)
  - **Inline-swap the approval card on click.** Clicking Approve or Deny on a dangerous-tool approval card now atomically replaces the card with a resolved-state variant (green ✅ "Approved" / grey ❌ "Denied", no buttons, signed by clicker + timestamp). `buildApprovalCard` now sets `config.update_multi: true` (required for inline replacement), `CardActionResponse` gains an optional `card?: { type: 'raw'; data }` field, `buildResolvedCard` is newly exported from `@postline/adapters-feishu`, and `PendingActions` gains a `get(id)` accessor so adapters can read entry metadata before resolving. (#2)

- Updated dependencies
  - @postline/core@0.1.10

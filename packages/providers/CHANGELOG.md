# @postline/providers

## 0.7.0

### Patch Changes

- fix: shared `runModelChain` with at-most-once content — no duplication on mid-stream fallback (#72)

## 0.6.0

### Patch Changes

- Updated dependencies [d8791cb]
- Updated dependencies [5040a61]
  - @postline/core@0.6.0

## 0.5.0

### Patch Changes

- Updated dependencies [1c3efa3]
- Updated dependencies [d92d505]
  - @postline/core@0.5.0

## 0.4.0

### Minor Changes

- 299d3de: Add prompt caching breakpoints to the system prompt and tool array. Both Bedrock (`cachePoint: {type: 'default'}`) and Anthropic (`cache_control: {type: 'ephemeral'}`) now cache the stable prefix of every request, so subsequent turns within the cache window pay ~10% of the input-token cost on the cached portion.

  **Pre-1.0 API change** (minor):

  - `TurnRequest.system` was `string`, now `readonly SystemSegment[]` where `SystemSegment = { text: string; cacheable?: boolean }`. Cacheable segments end a cache breakpoint at that position. The host (`@postline/core`'s `runTurn`) builds the segments — out-of-tree consumers calling provider `stream()` directly need to migrate from `system: 'foo'` to `system: [{ text: 'foo' }]`.

  Default postline cache layout from `runTurn`:

  1. Stable system block (`SYSTEM_PROMPT_BASE` + skill/runtime suffix) → `cacheable: true` → cache breakpoint after.
  2. Memory block (`=== MEMORY ===` + memory text) → not cacheable (changes when `memory_write` fires).
  3. Tool specs → all-or-nothing cache via a single breakpoint at end (handled in providers, not turn).

  Both providers were updated to translate the segments into their native cache-marker shape:

  - **Bedrock Converse**: emits `system: [{text}, {cachePoint:{type:'default'}}, {text}]` and appends a `{cachePoint:{type:'default'}}` element after the tool array when at least one tool is present.
  - **Anthropic Messages**: emits `system: [{type:'text', text, cache_control:{type:'ephemeral'}?}, ...]` and adds `cache_control:{type:'ephemeral'}` to the LAST tool spec (Anthropic semantics: cache_control on tool N caches everything up to and including tool N).

  The `usage` chunks already surface `cacheReadTokens` and `cacheCreationTokens` — `postline_stats action='usage'` will start showing the cache split once turns run with this build.

  14 new unit tests cover both providers' segment+tool conversion, including all-cacheable, none-cacheable, empty-text-skip, and last-tool-only cache-control invariants.

### Patch Changes

- 68b1e5b: Bump `@anthropic-ai/sdk` from `^0.40.0` to `^0.100.1`. Removes the `unknown` cast workaround in the anthropic provider's adaptive-thinking request — the SDK now natively types `thinking.type: 'adaptive'` and `output_config.effort`, so the provider passes through cleanly.

  Internal-only change. No public-facing API surface affected; tests still 446/446. The SDK's stream-event shape (`message_start` / `content_block_start` / `content_block_delta` / `content_block_stop` / `message_delta` / `message_stop`) is unchanged across the version range, so the existing event handling in `streamOne` works untouched.

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

## 0.2.0

### Minor Changes

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

- fcb8351: Add HTTP-level retry with exponential backoff to both `bedrock` and `anthropic` providers. Transient infrastructure errors (Throttling, ServiceUnavailable, InternalServer, RateLimit, network ECONNRESET / ETIMEDOUT, etc.) now retry up to 2 times per model attempt before falling through to the next fallback model. Permanent errors (Validation, AccessDenied, NotFound, abort) bypass retry as before.

  Backoff is exponential with base 4: 100ms, 400ms, 1600ms (capped at 5s). Retries are bounded to the HTTP send only — once stream iteration starts, any error there falls back to the next model unchanged, since chunks already yielded would otherwise duplicate.

  Each retry logs `provider_retry` with `{provider, model, attempt, delayMs, errName, err}` so quota / throttle bursts are visible in journalctl.

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

# @postline/adapters-feishu

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

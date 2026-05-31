---
'@postline/adapters-feishu': patch
'@postline/core': patch
'@postline/providers': patch
'@postline/tools-builtin': patch
---

Add in-process metrics — counters and histograms for provider attempts, retries, fallbacks, turn outcomes, tool durations, and history sanitization. Surfaced through the existing `postline_stats` tool's new `metrics` action so the bot can report its own throttle / failover / orphan-recovery activity in chat without needing journalctl access.

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

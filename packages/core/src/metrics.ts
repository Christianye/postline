/**
 * Lightweight in-process metrics for postline. Counters and histograms only;
 * no gauges (we never need a "current value" we can decrement). All state
 * lives in memory and resets on process restart — pair with the existing
 * usage.jsonl + journalctl for persistent observability.
 *
 * Design constraints:
 * - Single-process, single-thread (Node event loop). No locks needed.
 * - Cardinality control: caller is responsible for using bounded label values
 *   (model id, tool name, outcome). We don't enforce a label allowlist; tests
 *   verify the call sites stay within a known small set.
 * - No external dependency (no prom-client). The exporter is a tiny `dump()`
 *   method returning a structured snapshot the host can render however it
 *   wants — postline_stats prints a human-readable table.
 */

export type MetricLabels = Readonly<Record<string, string>>;

export interface CounterSnapshot {
  name: string;
  description: string;
  series: Array<{ labels: MetricLabels; value: number }>;
}

export interface HistogramSnapshot {
  name: string;
  description: string;
  /** Bucket upper bounds in ms (or whatever unit the histogram tracks). */
  buckets: readonly number[];
  series: Array<{
    labels: MetricLabels;
    count: number;
    sum: number;
    /**
     * `bucketCounts[i]` is the number of observations with value ≤ buckets[i].
     * Cumulative, Prometheus-style, so the last entry equals `count`.
     */
    bucketCounts: number[];
  }>;
}

export interface MetricsSnapshot {
  counters: CounterSnapshot[];
  histograms: HistogramSnapshot[];
  /** When the metrics registry was created (process start, typically). */
  startedAtMs: number;
  /** When this snapshot was rendered. */
  snapshotAtMs: number;
}

/**
 * Histograms use these buckets by default. Tuned for tool / provider call
 * latencies, which range from a few ms (memory read) to tens of seconds
 * (long bash) and rare minutes (web fetch on slow hosts).
 */
export const DEFAULT_DURATION_BUCKETS_MS: readonly number[] = [
  10, 50, 100, 250, 500, 1000, 2500, 5000, 10_000, 30_000, 60_000, 120_000,
] as const;

interface CounterState {
  description: string;
  values: Map<string, number>; // key = serialised labels
  labelKeys: Map<string, MetricLabels>;
}

interface HistogramState {
  description: string;
  buckets: readonly number[];
  series: Map<string, { labels: MetricLabels; count: number; sum: number; bucketCounts: number[] }>;
}

export interface MetricsRegistry {
  /** Increment a counter. `inc()` defaults `value` to 1. */
  inc(name: string, labels?: MetricLabels, value?: number): void;
  /** Record an observation in a histogram (typically a duration in ms). */
  observe(name: string, value: number, labels?: MetricLabels): void;
  /**
   * Convenience: time `fn()` and record its duration in `name`. Errors thrown
   * by `fn` are still observed (under labels with `outcome=error` if the
   * caller asks for it). The function returns `fn`'s resolved value.
   */
  time<T>(
    name: string,
    fn: () => Promise<T>,
    labelsFor?: (outcome: 'ok' | 'error') => MetricLabels,
  ): Promise<T>;
  /** Take a structured snapshot of all metrics. Used by `postline_stats`. */
  dump(): MetricsSnapshot;
  /** Reset all state — only for tests. */
  reset(): void;
}

export interface MetricsRegistryOptions {
  /** Counter declarations: `name → description`. Names must be pre-declared. */
  counters?: Record<string, string>;
  /** Histogram declarations: `name → { description, buckets? }`. */
  histograms?: Record<string, { description: string; buckets?: readonly number[] }>;
  nowMs?: () => number;
}

/**
 * Create a metrics registry. Counters and histograms must be pre-declared so
 * `dump()` can list zero-valued metrics on a fresh process (otherwise tests
 * and humans see "no data" and can't tell whether the metric just hasn't
 * fired or doesn't exist).
 */
export function createMetricsRegistry(opts: MetricsRegistryOptions = {}): MetricsRegistry {
  const nowMs = opts.nowMs ?? (() => Date.now());
  const startedAtMs = nowMs();

  const counters = new Map<string, CounterState>();
  for (const [name, description] of Object.entries(opts.counters ?? {})) {
    counters.set(name, {
      description,
      values: new Map(),
      labelKeys: new Map(),
    });
  }

  const histograms = new Map<string, HistogramState>();
  for (const [name, def] of Object.entries(opts.histograms ?? {})) {
    histograms.set(name, {
      description: def.description,
      buckets: def.buckets ?? DEFAULT_DURATION_BUCKETS_MS,
      series: new Map(),
    });
  }

  function labelKey(labels: MetricLabels | undefined): string {
    if (!labels) return '';
    const keys = Object.keys(labels).sort();
    return keys.map((k) => `${k}=${labels[k]}`).join(',');
  }

  const api: MetricsRegistry = {
    inc(name, labels, value = 1) {
      const c = counters.get(name);
      if (!c) {
        throw new Error(`metrics: counter '${name}' not declared`);
      }
      const k = labelKey(labels);
      c.values.set(k, (c.values.get(k) ?? 0) + value);
      if (!c.labelKeys.has(k)) c.labelKeys.set(k, labels ?? {});
    },
    observe(name, value, labels) {
      const h = histograms.get(name);
      if (!h) {
        throw new Error(`metrics: histogram '${name}' not declared`);
      }
      const k = labelKey(labels);
      let s = h.series.get(k);
      if (!s) {
        s = {
          labels: labels ?? {},
          count: 0,
          sum: 0,
          bucketCounts: new Array(h.buckets.length).fill(0),
        };
        h.series.set(k, s);
      }
      s.count += 1;
      s.sum += value;
      for (let i = 0; i < h.buckets.length; i++) {
        const upper = h.buckets[i];
        if (upper === undefined) continue;
        if (value <= upper) s.bucketCounts[i] = (s.bucketCounts[i] ?? 0) + 1;
      }
    },
    async time(name, fn, labelsFor) {
      const start = nowMs();
      try {
        const out = await fn();
        api.observe(name, nowMs() - start, labelsFor?.('ok'));
        return out;
      } catch (e) {
        api.observe(name, nowMs() - start, labelsFor?.('error'));
        throw e;
      }
    },
    dump() {
      const counterOut: CounterSnapshot[] = [];
      for (const [name, state] of counters) {
        const series: CounterSnapshot['series'] = [];
        for (const [k, v] of state.values) {
          series.push({ labels: state.labelKeys.get(k) ?? {}, value: v });
        }
        counterOut.push({ name, description: state.description, series });
      }
      const histOut: HistogramSnapshot[] = [];
      for (const [name, state] of histograms) {
        const series: HistogramSnapshot['series'] = [];
        for (const s of state.series.values()) {
          series.push({
            labels: s.labels,
            count: s.count,
            sum: s.sum,
            bucketCounts: [...s.bucketCounts],
          });
        }
        histOut.push({ name, description: state.description, buckets: state.buckets, series });
      }
      return {
        counters: counterOut,
        histograms: histOut,
        startedAtMs,
        snapshotAtMs: nowMs(),
      };
    },
    reset() {
      for (const c of counters.values()) {
        c.values.clear();
        c.labelKeys.clear();
      }
      for (const h of histograms.values()) {
        h.series.clear();
      }
    },
  };
  return api;
}

/**
 * The canonical postline metrics registry config. Centralised so providers,
 * the turn loop, and `postline_stats` agree on names + labels.
 */
export const POSTLINE_METRICS = {
  counters: {
    provider_attempt_total: 'Number of provider stream-creation attempts, by outcome.',
    provider_retry_total: 'Number of HTTP-level retries inside a single attempt.',
    provider_fallback_total: 'Number of times the provider fell through to the next model.',
    turn_total: 'Number of completed turns, by outcome.',
    tool_total: 'Number of tool invocations, by name and outcome.',
    history_orphan_dropped_total:
      'Number of orphan tool_use rows dropped on history load (sanitization).',
  },
  histograms: {
    tool_duration_ms: {
      description: 'Tool execution duration in ms, by tool name and outcome.',
      buckets: DEFAULT_DURATION_BUCKETS_MS,
    },
    turn_duration_ms: {
      description: 'End-to-end turn duration in ms, by outcome.',
      buckets: DEFAULT_DURATION_BUCKETS_MS,
    },
  },
} as const;

/** Create a registry pre-loaded with the canonical postline metric set. */
export function createPostlineMetrics(opts: { nowMs?: () => number } = {}): MetricsRegistry {
  return createMetricsRegistry({
    counters: { ...POSTLINE_METRICS.counters },
    histograms: { ...POSTLINE_METRICS.histograms },
    ...(opts.nowMs ? { nowMs: opts.nowMs } : {}),
  });
}

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_DURATION_BUCKETS_MS,
  createMetricsRegistry,
  createPostlineMetrics,
} from './metrics.js';

describe('createMetricsRegistry — counters', () => {
  it('throws when incrementing an undeclared counter', () => {
    const m = createMetricsRegistry({ counters: { ok: 'declared' } });
    expect(() => m.inc('not_declared')).toThrow(/not declared/);
  });

  it('starts at zero — undeclared series are visible in dump as zero', () => {
    const m = createMetricsRegistry({ counters: { foo_total: 'desc' } });
    const snap = m.dump();
    const counter = snap.counters.find((c) => c.name === 'foo_total');
    expect(counter).toBeDefined();
    expect(counter?.series).toEqual([]);
  });

  it('inc with no labels accumulates on the empty-label series', () => {
    const m = createMetricsRegistry({ counters: { foo: 'desc' } });
    m.inc('foo');
    m.inc('foo');
    m.inc('foo', undefined, 3);
    const c = m.dump().counters[0];
    expect(c?.series).toEqual([{ labels: {}, value: 5 }]);
  });

  it('inc with labels keeps separate series per label set', () => {
    const m = createMetricsRegistry({
      counters: { hits: 'http hits, by route + status' },
    });
    m.inc('hits', { route: '/a', status: '200' });
    m.inc('hits', { route: '/a', status: '200' });
    m.inc('hits', { route: '/b', status: '500' });
    const c = m.dump().counters[0];
    expect(c?.series).toContainEqual({ labels: { route: '/a', status: '200' }, value: 2 });
    expect(c?.series).toContainEqual({ labels: { route: '/b', status: '500' }, value: 1 });
  });

  it('label key is order-insensitive', () => {
    const m = createMetricsRegistry({ counters: { x: 'desc' } });
    m.inc('x', { a: '1', b: '2' });
    m.inc('x', { b: '2', a: '1' });
    expect(m.dump().counters[0]?.series).toHaveLength(1);
    expect(m.dump().counters[0]?.series[0]?.value).toBe(2);
  });
});

describe('createMetricsRegistry — histograms', () => {
  it('throws when observing an undeclared histogram', () => {
    const m = createMetricsRegistry();
    expect(() => m.observe('h', 1)).toThrow(/not declared/);
  });

  it('records cumulative bucket counts (Prometheus style)', () => {
    const m = createMetricsRegistry({
      histograms: { lat: { description: 'latency', buckets: [10, 100, 1000] } },
    });
    m.observe('lat', 5); // ≤10, ≤100, ≤1000 → all 3
    m.observe('lat', 50); // ≤100, ≤1000
    m.observe('lat', 500); // ≤1000
    m.observe('lat', 5000); // none — beyond last bucket
    const h = m.dump().histograms[0];
    expect(h?.series[0]?.bucketCounts).toEqual([1, 2, 3]);
    expect(h?.series[0]?.count).toBe(4);
    expect(h?.series[0]?.sum).toBe(5555);
  });

  it('separates series by label', () => {
    const m = createMetricsRegistry({
      histograms: { lat: { description: 'd', buckets: [10] } },
    });
    m.observe('lat', 5, { tool: 'a' });
    m.observe('lat', 5, { tool: 'b' });
    m.observe('lat', 5, { tool: 'a' });
    const series = m.dump().histograms[0]?.series ?? [];
    const a = series.find((s) => s.labels.tool === 'a');
    const b = series.find((s) => s.labels.tool === 'b');
    expect(a?.count).toBe(2);
    expect(b?.count).toBe(1);
  });

  it('time() records duration and observes outcome=ok on success', async () => {
    const m = createMetricsRegistry({
      histograms: { d: { description: 'd', buckets: [10, 100] } },
    });
    const out = await m.time(
      'd',
      async () => {
        await new Promise((r) => setTimeout(r, 5));
        return 42;
      },
      (outcome) => ({ outcome }),
    );
    expect(out).toBe(42);
    const series = m.dump().histograms[0]?.series ?? [];
    expect(series).toHaveLength(1);
    expect(series[0]?.labels.outcome).toBe('ok');
    expect(series[0]?.count).toBe(1);
  });

  it('time() records outcome=error and rethrows on failure', async () => {
    const m = createMetricsRegistry({
      histograms: { d: { description: 'd', buckets: [10] } },
    });
    await expect(
      m.time(
        'd',
        async () => {
          throw new Error('boom');
        },
        (outcome) => ({ outcome }),
      ),
    ).rejects.toThrow('boom');
    const series = m.dump().histograms[0]?.series ?? [];
    expect(series[0]?.labels.outcome).toBe('error');
  });
});

describe('createMetricsRegistry — reset / dump', () => {
  it('reset() clears all counter and histogram state', () => {
    const m = createMetricsRegistry({
      counters: { a: 'd' },
      histograms: { b: { description: 'd', buckets: [10] } },
    });
    m.inc('a');
    m.observe('b', 5);
    m.reset();
    const snap = m.dump();
    expect(snap.counters[0]?.series).toEqual([]);
    expect(snap.histograms[0]?.series).toEqual([]);
  });

  it('dump() includes a startedAtMs and snapshotAtMs from the injected clock', () => {
    let now = 1000;
    const m = createMetricsRegistry({ counters: { a: 'd' }, nowMs: () => now });
    now = 2000;
    const snap = m.dump();
    expect(snap.startedAtMs).toBe(1000);
    expect(snap.snapshotAtMs).toBe(2000);
  });
});

describe('createPostlineMetrics', () => {
  it('declares the canonical postline counter + histogram set', () => {
    const m = createPostlineMetrics();
    const snap = m.dump();
    const names = snap.counters.map((c) => c.name).concat(snap.histograms.map((h) => h.name));
    expect(names).toEqual(
      expect.arrayContaining([
        'provider_attempt_total',
        'provider_retry_total',
        'provider_fallback_total',
        'turn_total',
        'tool_total',
        'history_orphan_dropped_total',
        'tool_duration_ms',
        'turn_duration_ms',
      ]),
    );
  });

  it('uses the default duration buckets for tool_duration_ms', () => {
    const m = createPostlineMetrics();
    const h = m.dump().histograms.find((x) => x.name === 'tool_duration_ms');
    expect(h?.buckets).toEqual(DEFAULT_DURATION_BUCKETS_MS);
  });
});

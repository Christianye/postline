import { describe, expect, it, vi } from 'vitest';
import { EventDedup } from './dedup.js';

describe('EventDedup', () => {
  it('blocks exact duplicates', () => {
    const d = new EventDedup();
    d.add('a');
    expect(d.has('a')).toBe(true);
    expect(d.has('b')).toBe(false);
  });

  it('expires entries after ttl', () => {
    vi.useFakeTimers();
    const d = new EventDedup(100, 1000);
    d.add('x');
    vi.advanceTimersByTime(1100);
    expect(d.has('x')).toBe(false);
    vi.useRealTimers();
  });

  it('evicts oldest when full', () => {
    const d = new EventDedup(2, 60_000);
    d.add('a');
    d.add('b');
    d.add('c'); // should evict 'a'
    expect(d.has('a')).toBe(false);
    expect(d.has('b')).toBe(true);
    expect(d.has('c')).toBe(true);
  });
});

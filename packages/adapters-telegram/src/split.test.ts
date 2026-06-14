import { describe, expect, it } from 'vitest';
import { splitForTelegram } from './split.js';

describe('splitForTelegram', () => {
  it('returns a single chunk when under the limit', () => {
    expect(splitForTelegram('hello')).toEqual(['hello']);
  });

  it('splits at paragraph boundaries and adds chunk headers', () => {
    const a = 'a'.repeat(2500);
    const b = 'b'.repeat(2500);
    const out = splitForTelegram(`${a}\n\n${b}`, 4000);
    expect(out.length).toBe(2);
    expect(out[0]).toContain('(1/2)');
    expect(out[1]).toContain('(2/2)');
    expect(out[0]).toContain(a);
    expect(out[1]).toContain(b);
  });

  it('hard-splits a single oversized line as a last resort', () => {
    const big = 'x'.repeat(9000);
    const out = splitForTelegram(big, 4000);
    expect(out.length).toBeGreaterThanOrEqual(3);
    // every chunk minus its header is within the limit
    for (const chunk of out) {
      expect(chunk.length).toBeLessThanOrEqual(4000 + 12);
    }
  });

  it('keeps a chunk under the 4096 Telegram hard limit', () => {
    const out = splitForTelegram('y'.repeat(20000));
    for (const chunk of out) expect(chunk.length).toBeLessThanOrEqual(4096);
  });
});

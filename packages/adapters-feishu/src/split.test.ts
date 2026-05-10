import { describe, expect, it } from 'vitest';
import { splitForFeishu } from './split.js';

describe('splitForFeishu', () => {
  it('returns single chunk for short text', () => {
    expect(splitForFeishu('hello')).toEqual(['hello']);
  });

  it('returns single chunk for exactly at limit', () => {
    const s = 'x'.repeat(4500);
    expect(splitForFeishu(s, 4500)).toEqual([s]);
  });

  it('splits at paragraph boundary', () => {
    const p1 = 'x'.repeat(3000);
    const p2 = 'y'.repeat(3000);
    const out = splitForFeishu(`${p1}\n\n${p2}`, 4500);
    expect(out).toHaveLength(2);
    expect(out[0]).toMatch(/^_\(1\/2\)_ x{3000}$/);
    expect(out[1]).toMatch(/^_\(2\/2\)_ y{3000}$/);
  });

  it('falls back to line split when paragraph is too big', () => {
    const line1 = 'a'.repeat(3000);
    const line2 = 'b'.repeat(3000);
    const bigPara = `${line1}\n${line2}`;
    const out = splitForFeishu(bigPara, 4500);
    expect(out).toHaveLength(2);
    expect(out[0]).toContain(line1);
    expect(out[1]).toContain(line2);
  });

  it('hard-splits a single line that exceeds the limit', () => {
    const s = 'z'.repeat(10_000);
    const out = splitForFeishu(s, 4500);
    expect(out.length).toBeGreaterThanOrEqual(3);
    const totalChars = out.reduce((sum, c) => sum + c.replace(/^_\(\d+\/\d+\)_ /, '').length, 0);
    expect(totalChars).toBe(10_000);
  });

  it('numbers chunks in order', () => {
    const text = Array.from({ length: 5 }, (_, i) => `p${i}${'x'.repeat(2000)}`).join('\n\n');
    const out = splitForFeishu(text, 4500);
    for (let i = 0; i < out.length; i++) {
      expect(out[i]).toMatch(new RegExp(`^_\\(${i + 1}/${out.length}\\)_ `));
    }
  });

  it('packs small paragraphs greedily rather than one-per-chunk', () => {
    const parts = Array.from({ length: 10 }, (_, i) => `para${i} short`);
    const text = parts.join('\n\n');
    const out = splitForFeishu(text, 4500);
    // All 10 short paragraphs fit in one chunk.
    expect(out).toHaveLength(1);
  });
});

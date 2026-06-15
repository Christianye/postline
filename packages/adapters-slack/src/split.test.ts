import { describe, expect, it } from 'vitest';
import { splitForSlack } from './split.js';

describe('splitForSlack', () => {
  it('returns a single chunk under the limit', () => {
    expect(splitForSlack('hi')).toEqual(['hi']);
  });

  it('splits at paragraph boundaries with chunk headers', () => {
    const a = 'a'.repeat(2000);
    const b = 'b'.repeat(2000);
    const out = splitForSlack(`${a}\n\n${b}`, 3500);
    expect(out.length).toBe(2);
    expect(out[0]).toContain('(1/2)');
    expect(out[1]).toContain('(2/2)');
  });

  it('hard-splits an oversized single line', () => {
    const out = splitForSlack('x'.repeat(8000), 3500);
    expect(out.length).toBeGreaterThanOrEqual(3);
    for (const c of out) expect(c.length).toBeLessThanOrEqual(3500 + 12);
  });
});

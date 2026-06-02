import type { ToolSpec } from '@postline/core';
import { describe, expect, it } from 'vitest';
import {
  __convertSystemSegmentsForTest as convertSystemSegments,
  __convertToolsForTest as convertTools,
} from './index.js';

describe('Bedrock convertSystemSegments — cachePoint markers', () => {
  it('emits a {text} block per non-empty segment', () => {
    const out = convertSystemSegments([{ text: 'a' }, { text: 'b' }]);
    expect(out).toEqual([{ text: 'a' }, { text: 'b' }]);
  });

  it('skips empty-text segments', () => {
    const out = convertSystemSegments([{ text: '' }, { text: 'kept' }]);
    expect(out).toEqual([{ text: 'kept' }]);
  });

  it('inserts a cachePoint marker AFTER cacheable segments', () => {
    const out = convertSystemSegments([{ text: 'stable', cacheable: true }, { text: 'volatile' }]);
    expect(out).toEqual([
      { text: 'stable' },
      { cachePoint: { type: 'default' } },
      { text: 'volatile' },
    ]);
  });

  it('multiple cache breakpoints (each cacheable→its own marker)', () => {
    const out = convertSystemSegments([
      { text: 'a', cacheable: true },
      { text: 'b', cacheable: true },
    ]);
    expect(out).toEqual([
      { text: 'a' },
      { cachePoint: { type: 'default' } },
      { text: 'b' },
      { cachePoint: { type: 'default' } },
    ]);
  });
});

describe('Bedrock convertTools — cachePoint marker', () => {
  const t: ToolSpec = { name: 'echo', description: 'd', inputSchema: { type: 'object' } };

  it('returns undefined for empty input', () => {
    expect(convertTools([])).toBeUndefined();
    expect(convertTools([], true)).toBeUndefined();
  });

  it('without cache point: pure toolSpec list', () => {
    const out = convertTools([t]);
    expect(out).toHaveLength(1);
    expect((out as Array<{ toolSpec: { name: string } }>)[0]?.toolSpec?.name).toBe('echo');
  });

  it('with cache point: appends a {cachePoint} entry as the last element', () => {
    const out = convertTools([t, { ...t, name: 'echo2' }], true);
    expect(out).toHaveLength(3);
    const cast = out as Array<{ toolSpec?: { name: string }; cachePoint?: { type: 'default' } }>;
    expect(cast[0]?.toolSpec?.name).toBe('echo');
    expect(cast[1]?.toolSpec?.name).toBe('echo2');
    expect(cast[2]?.cachePoint).toEqual({ type: 'default' });
  });
});

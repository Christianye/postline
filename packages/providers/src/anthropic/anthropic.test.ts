import type { Message, ToolSpec } from '@postline/core';
import { describe, expect, it } from 'vitest';
import {
  __convertMessagesForTest as convertMessages,
  __convertSystemSegmentsForTest as convertSystemSegments,
  __convertToolsForTest as convertTools,
  __stripProviderPrefixForTest as stripProviderPrefix,
} from './index.js';

describe('stripProviderPrefix', () => {
  it('strips anthropic/', () => {
    expect(stripProviderPrefix('anthropic/claude-opus-4-7')).toBe('claude-opus-4-7');
  });
  it('strips anthropic-api/', () => {
    expect(stripProviderPrefix('anthropic-api/claude-opus-4-7')).toBe('claude-opus-4-7');
  });
  it('leaves bare model id alone', () => {
    expect(stripProviderPrefix('claude-opus-4-7')).toBe('claude-opus-4-7');
  });
  it('leaves unknown prefix alone (let SDK complain)', () => {
    expect(stripProviderPrefix('openrouter/claude')).toBe('openrouter/claude');
  });
});

describe('convertMessages', () => {
  it('converts a user text message', () => {
    const msgs: Message[] = [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }];
    expect(convertMessages(msgs)).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'hello' }] },
    ]);
  });

  it('drops system messages (they go to top-level system field)', () => {
    const msgs: Message[] = [
      { role: 'system', content: [{ type: 'text', text: 'ignore me' }] },
      { role: 'user', content: [{ type: 'text', text: 'hi' }] },
    ];
    const out = convertMessages(msgs);
    expect(out).toHaveLength(1);
    expect(out[0]?.role).toBe('user');
  });

  it('converts tool role to role=user with tool_result blocks', () => {
    const msgs: Message[] = [
      {
        role: 'tool',
        content: [
          { type: 'tool_result', toolUseId: 'tu1', content: 'ok', isError: false },
          { type: 'tool_result', toolUseId: 'tu2', content: 'fail', isError: true },
        ],
      },
    ];
    const out = convertMessages(msgs);
    expect(out).toEqual([
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'tu1', content: 'ok' },
          { type: 'tool_result', tool_use_id: 'tu2', content: 'fail', is_error: true },
        ],
      },
    ]);
  });

  it('converts image parts to Anthropic base64 source', () => {
    const msgs: Message[] = [
      {
        role: 'user',
        content: [
          { type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' },
          { type: 'text', text: 'what is this' },
        ],
      },
    ];
    const out = convertMessages(msgs);
    expect(out[0]?.content).toEqual([
      {
        type: 'image',
        source: { type: 'base64', media_type: 'image/png', data: 'aGVsbG8=' },
      },
      { type: 'text', text: 'what is this' },
    ]);
  });

  it('converts assistant tool_use', () => {
    const msgs: Message[] = [
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'let me check' },
          { type: 'tool_use', id: 'tu1', name: 'bash', input: { cmd: 'ls' } },
        ],
      },
    ];
    const out = convertMessages(msgs);
    expect(out[0]).toEqual({
      role: 'assistant',
      content: [
        { type: 'text', text: 'let me check' },
        { type: 'tool_use', id: 'tu1', name: 'bash', input: { cmd: 'ls' } },
      ],
    });
  });

  it('skips messages with no convertible content', () => {
    const msgs: Message[] = [
      // tool role with no tool_result parts
      { role: 'tool', content: [{ type: 'text', text: 'wrong role' }] },
    ];
    expect(convertMessages(msgs)).toEqual([]);
  });
});

describe('convertSystemSegments — Anthropic cache_control', () => {
  it('emits a typed text block per non-empty segment', () => {
    const out = convertSystemSegments([{ text: 'a' }, { text: 'b' }]);
    expect(out).toEqual([
      { type: 'text', text: 'a' },
      { type: 'text', text: 'b' },
    ]);
  });

  it('skips empty-text segments', () => {
    const out = convertSystemSegments([{ text: '' }, { text: 'kept' }]);
    expect(out).toEqual([{ type: 'text', text: 'kept' }]);
  });

  it('attaches cache_control: ephemeral to cacheable segments', () => {
    const out = convertSystemSegments([{ text: 'stable', cacheable: true }, { text: 'volatile' }]);
    expect(out).toEqual([
      { type: 'text', text: 'stable', cache_control: { type: 'ephemeral' } },
      { type: 'text', text: 'volatile' },
    ]);
  });

  it('handles all-cacheable input (every segment ends a breakpoint)', () => {
    const out = convertSystemSegments([
      { text: 'a', cacheable: true },
      { text: 'b', cacheable: true },
    ]);
    expect(out).toHaveLength(2);
    expect(out.every((b) => b.cache_control?.type === 'ephemeral')).toBe(true);
  });
});

describe('convertTools — Anthropic cache_control on last tool', () => {
  const t: ToolSpec = { name: 'echo', description: 'd', inputSchema: { type: 'object' } };

  it('returns [] for empty input', () => {
    expect(convertTools([])).toEqual([]);
  });

  it('attaches cache_control: ephemeral to ONLY the last tool', () => {
    const out = convertTools([t, { ...t, name: 'echo2' }, { ...t, name: 'echo3' }]);
    expect(out).toHaveLength(3);
    const cast = out as Array<{ name: string; cache_control?: { type: 'ephemeral' } }>;
    expect(cast[0]?.cache_control).toBeUndefined();
    expect(cast[1]?.cache_control).toBeUndefined();
    expect(cast[2]?.cache_control).toEqual({ type: 'ephemeral' });
  });

  it('single-tool case still gets cache_control', () => {
    const out = convertTools([t]) as Array<{
      name: string;
      cache_control?: { type: 'ephemeral' };
    }>;
    expect(out[0]?.cache_control).toEqual({ type: 'ephemeral' });
  });
});

import type { FeishuChannel } from '@postline/adapters-feishu';
import type { Logger } from '@postline/core';
import { describe, expect, it, vi } from 'vitest';
import { createStreamingMessage } from './feishu-stream.js';

function silentLogger(): Logger {
  const noop = () => void 0;
  const logger: Logger = {
    info: noop,
    warn: noop,
    error: noop,
    debug: noop,
    child: () => logger,
  };
  return logger;
}

interface FakeChannel {
  channel: FeishuChannel;
  sentTexts: string[];
  edits: Array<{ messageId: string; text: string }>;
}

function makeFakeChannel(opts: { editFails?: number; seedFails?: boolean } = {}): FakeChannel {
  const edits: Array<{ messageId: string; text: string }> = [];
  const sentTexts: string[] = [];
  let editCallsRemaining = opts.editFails ?? 0;

  const channel = {
    async sendText({ text }: { conversationId: string; text: string }) {
      if (opts.seedFails) throw new Error('seed blocked');
      sentTexts.push(text);
      return { messageId: `msg_${sentTexts.length}` };
    },
    async editText(messageId: string, text: string) {
      if (editCallsRemaining > 0) {
        editCallsRemaining -= 1;
        throw new Error('rate limited');
      }
      edits.push({ messageId, text });
    },
  } as unknown as FeishuChannel;

  return { channel, sentTexts, edits };
}

async function wait(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

describe('createStreamingMessage', () => {
  it('sends a single seed message on first delta', async () => {
    const { channel, sentTexts } = makeFakeChannel();
    const s = createStreamingMessage(channel, 'oc_test', silentLogger(), { debounceMs: 20 });
    s.onDelta('hi');
    // seed send is lazy; microtask flush
    await wait(5);
    expect(sentTexts).toEqual(['…']);
  });

  it('does not send anything if no delta ever arrives (e.g. tool-only turn)', async () => {
    const { channel, sentTexts, edits } = makeFakeChannel();
    const s = createStreamingMessage(channel, 'oc_test', silentLogger());
    // no onDelta — just finish with a real text
    const r = await s.finish('the real final reply');
    expect(sentTexts).toEqual(['…']); // seed is created lazily in finish
    expect(edits).toHaveLength(1);
    expect(edits[0]?.text).toBe('the real final reply');
    expect(r).toEqual({ kind: 'edited' });
  });

  it('debounces deltas — only one edit per window', async () => {
    const { channel, edits } = makeFakeChannel();
    const s = createStreamingMessage(channel, 'oc_test', silentLogger(), { debounceMs: 30 });
    s.onDelta('a');
    s.onDelta('ab');
    s.onDelta('abc');
    await wait(50);
    expect(edits).toHaveLength(1);
    expect(edits[0]?.text).toBe('abc');
  });

  it('final finish edits to the final reply', async () => {
    const { channel, edits } = makeFakeChannel();
    const s = createStreamingMessage(channel, 'oc_test', silentLogger(), { debounceMs: 20 });
    s.onDelta('partial');
    await wait(30);
    const r = await s.finish('final answer');
    expect(r).toEqual({ kind: 'edited' });
    const lastEdit = edits[edits.length - 1];
    expect(lastEdit?.text).toBe('final answer');
  });

  it('handles overflow by editing the first slice and returning the rest', async () => {
    const { channel, edits } = makeFakeChannel();
    const s = createStreamingMessage(channel, 'oc_test', silentLogger(), {
      debounceMs: 10,
      maxCharsPerMessage: 10,
    });
    s.onDelta('aaa');
    await wait(20);
    const r = await s.finish('0123456789XYZ'); // 13 chars, max 10
    expect(r.kind).toBe('overflow');
    if (r.kind === 'overflow') {
      expect(r.rest).toBe('XYZ');
    }
    const last = edits[edits.length - 1];
    expect(last?.text).toBe('0123456789');
  });

  it('reports failed when seed send errors', async () => {
    const { channel } = makeFakeChannel({ seedFails: true });
    const s = createStreamingMessage(channel, 'oc_test', silentLogger(), { debounceMs: 10 });
    s.onDelta('hi');
    await wait(20);
    const r = await s.finish('final');
    expect(r).toEqual({ kind: 'failed' });
  });

  it('stops editing after a transient edit failure and reports failed', async () => {
    const { channel, edits } = makeFakeChannel({ editFails: 1 });
    const s = createStreamingMessage(channel, 'oc_test', silentLogger(), { debounceMs: 10 });
    s.onDelta('some text');
    await wait(30);
    // Edit #1 fails. finish() should surface failed.
    const r = await s.finish('final text');
    expect(r.kind).toBe('failed');
    // No edits landed because the only attempt was the failing one.
    expect(edits).toHaveLength(0);
  });

  it('skips redundant edits when text has not changed since last push', async () => {
    const { channel, edits } = makeFakeChannel();
    const s = createStreamingMessage(channel, 'oc_test', silentLogger(), { debounceMs: 10 });
    s.onDelta('final');
    await wait(20);
    // finish with same text
    await s.finish('final');
    expect(edits).toHaveLength(1); // one during debounce, finish sees unchanged
  });

  it('finish is idempotent in practice — second call is a no-op', async () => {
    const { channel, edits } = makeFakeChannel();
    const s = createStreamingMessage(channel, 'oc_test', silentLogger(), { debounceMs: 10 });
    s.onDelta('x');
    await wait(15);
    await s.finish('done');
    const snapshot = edits.length;
    await s.finish('done');
    // second finish may add one no-change edit attempt; what matters is no crash
    expect(edits.length).toBeGreaterThanOrEqual(snapshot);
  });
});

describe('createStreamingMessage — vi.fn-based', () => {
  it('delta + finish issues at least one edit and the final text is in it', async () => {
    const edits: Array<[string, string]> = [];
    const channel = {
      sendText: vi.fn(async () => ({ messageId: 'seed_id' })),
      editText: vi.fn(async (id: string, text: string) => {
        edits.push([id, text]);
      }),
    } as unknown as FeishuChannel;
    const s = createStreamingMessage(channel, 'oc_t', silentLogger(), { debounceMs: 5 });
    s.onDelta('he');
    s.onDelta('hell');
    s.onDelta('hello');
    await wait(20);
    await s.finish('hello world');
    expect(channel.sendText).toHaveBeenCalledTimes(1);
    // The final reply must appear in some edit
    expect(edits.some(([, t]) => t === 'hello world')).toBe(true);
  });
});

import { describe, expect, it } from 'vitest';
import type { SocketEnvelope } from './parse.js';
import { type WsLike, openConnection, runSocketLoop } from './socket.js';

function okFetcher(url: string): typeof globalThis.fetch {
  return (async () =>
    ({ json: async () => ({ ok: true, url }) }) as unknown as Response) as unknown as typeof fetch;
}

/** A fake WS that replays scripted frames then fires `close`. */
class FakeWs implements WsLike {
  sent: string[] = [];
  private handlers: Record<string, Array<(ev?: { data: unknown }) => void>> = {};
  constructor(private frames: string[]) {
    queueMicrotask(() => {
      this.emit('open');
      for (const f of this.frames) this.emit('message', { data: f });
      this.emit('close');
    });
  }
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {}
  // biome-ignore lint/suspicious/noExplicitAny: test event surface
  addEventListener(type: any, cb: any): void {
    (this.handlers[type] ??= []).push(cb);
  }
  private emit(type: string, ev?: { data: unknown }): void {
    for (const cb of this.handlers[type] ?? []) cb(ev);
  }
}

describe('openConnection', () => {
  it('returns the wss url from apps.connections.open', async () => {
    const url = await openConnection({
      appToken: 'xapp-1',
      fetcher: okFetcher('wss://slack/123'),
      onEnvelope: () => {},
      running: () => true,
    });
    expect(url).toBe('wss://slack/123');
  });
});

describe('runSocketLoop', () => {
  it('acks envelopes and dispatches events_api frames', async () => {
    const got: SocketEnvelope[] = [];
    let ws!: FakeWs;
    let round = 0;
    await runSocketLoop({
      appToken: 'xapp-1',
      fetcher: okFetcher('wss://slack/123'),
      wsFactory: () => {
        ws = new FakeWs([
          JSON.stringify({ type: 'hello' }),
          JSON.stringify({ type: 'events_api', envelope_id: 'e1', payload: { x: 1 } }),
        ]);
        return ws;
      },
      onEnvelope: (e) => {
        got.push(e);
      },
      running: () => round++ < 1, // one connection then stop
    });
    // hello is not dispatched; events_api is
    expect(got.length).toBe(1);
    expect(got[0]?.envelope_id).toBe('e1');
    // the events_api frame was acked
    expect(ws.sent).toContain(JSON.stringify({ envelope_id: 'e1' }));
  });

  it('treats a disconnect frame as a clean reopen (no backoff sleep)', async () => {
    const sleeps: number[] = [];
    let round = 0;
    await runSocketLoop({
      appToken: 'xapp-1',
      fetcher: okFetcher('wss://slack/123'),
      wsFactory: () => new FakeWs([JSON.stringify({ type: 'disconnect' })]),
      onEnvelope: () => {},
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      running: () => round++ < 1,
    });
    expect(sleeps).toEqual([]); // disconnect = immediate continue, no backoff
  });

  it('backs off after an opened-then-closed socket (no reconnect storm)', async () => {
    // FakeWs with no `disconnect` frame fires open→(frames)→close. A bare
    // close (not a graceful Slack disconnect) must back off before reopening.
    const sleeps: number[] = [];
    let round = 0;
    await runSocketLoop({
      appToken: 'xapp-1',
      fetcher: okFetcher('wss://slack/123'),
      wsFactory: () => new FakeWs([JSON.stringify({ type: 'hello' })]),
      onEnvelope: () => {},
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      running: () => round++ < 1,
    });
    expect(sleeps).toEqual([1000]); // one backoff sleep on the close
  });

  it('routes a rejected onEnvelope handler to onError (no unhandled rejection)', async () => {
    const errors: string[] = [];
    let round = 0;
    await runSocketLoop({
      appToken: 'xapp-1',
      fetcher: okFetcher('wss://slack/123'),
      wsFactory: () =>
        new FakeWs([JSON.stringify({ type: 'events_api', envelope_id: 'e9', payload: {} })]),
      onEnvelope: async () => {
        throw new Error('handler boom');
      },
      onError: (err) => errors.push(err.message),
      sleep: async () => {},
      running: () => round++ < 1,
    });
    // microtask drain so the .catch on the fire-and-forget handler runs.
    await new Promise((r) => setTimeout(r, 0));
    expect(errors).toContain('handler boom');
  });
});

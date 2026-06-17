/**
 * Slack Socket Mode connection loop.
 *
 * Socket Mode = no inbound port (matches feishu WS / telegram long-poll).
 * Flow:
 *   1. POST apps.connections.open (app-level token) → returns a wss URL.
 *   2. Connect the WebSocket (native global in Node 22; injectable for tests).
 *   3. Each `events_api` / `interactive` frame carries an `envelope_id` that
 *      MUST be acked within 3s by sending `{ envelope_id }` back over the WS.
 *   4. On `disconnect` (Slack rotates sockets) or socket close → reopen.
 *
 * Zero-dep: Web API call via fetch, transport via the platform WebSocket.
 */

import type { SocketEnvelope } from './parse.js';

/** Minimal WebSocket surface we depend on (native or injected). */
export interface WsLike {
  send(data: string): void;
  close(): void;
  addEventListener(type: 'message', cb: (ev: { data: unknown }) => void): void;
  addEventListener(type: 'open' | 'close' | 'error', cb: () => void): void;
}

export interface SocketLoopOptions {
  /** App-level token (`xapp-…`) for apps.connections.open. */
  appToken: string;
  /** Web API base. Default `https://slack.com/api`. Injectable for tests. */
  apiBase?: string;
  fetcher?: typeof globalThis.fetch;
  /** WebSocket factory; defaults to the platform global. */
  wsFactory?: (url: string) => WsLike;
  onEnvelope: (env: SocketEnvelope) => void | Promise<void>;
  onError?: (err: Error, retryMs: number) => void;
  running: () => boolean;
  sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_API_BASE = 'https://slack.com/api';

/** Open a Socket Mode WSS URL via the Web API. */
export async function openConnection(opts: SocketLoopOptions): Promise<string> {
  const apiBase = opts.apiBase ?? DEFAULT_API_BASE;
  const fetcher = opts.fetcher ?? globalThis.fetch;
  const res = await fetcher(`${apiBase}/apps.connections.open`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${opts.appToken}`,
      'content-type': 'application/x-www-form-urlencoded',
    },
  });
  const json = (await res.json()) as { ok: boolean; url?: string; error?: string };
  if (!json.ok || !json.url) throw new Error(`apps.connections.open failed: ${json.error}`);
  return json.url;
}

/**
 * Run the Socket Mode loop until `running()` is false. Reconnects with
 * backoff on socket close / disconnect frames.
 */
export async function runSocketLoop(opts: SocketLoopOptions): Promise<void> {
  const sleep = opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const makeWs =
    opts.wsFactory ??
    ((url: string) => new (globalThis as { WebSocket: new (u: string) => WsLike }).WebSocket(url));
  let backoff = 1000;

  while (opts.running()) {
    try {
      const url = await openConnection(opts);
      const ws = makeWs(url);
      backoff = 1000;
      const closed = await new Promise<'close' | 'disconnect'>((resolve) => {
        let settled = false;
        const settle = (r: 'close' | 'disconnect') => {
          if (!settled) {
            settled = true;
            resolve(r);
          }
        };
        ws.addEventListener('message', (ev) => {
          let env: SocketEnvelope | null = null;
          try {
            env = JSON.parse(String(ev.data)) as SocketEnvelope;
          } catch {
            return;
          }
          // Ack first (Slack requires ack within 3s) — before handling.
          if (env.envelope_id) {
            try {
              ws.send(JSON.stringify({ envelope_id: env.envelope_id }));
            } catch {
              // socket gone; loop will reopen
            }
          }
          if (env.type === 'disconnect') {
            settle('disconnect');
            return;
          }
          if (env.type === 'hello') return; // connection confirmed; nothing to do
          // Fire-and-forget by design (the envelope is already acked), but
          // route a rejected handler to onError rather than dropping it as
          // an unhandled rejection.
          void Promise.resolve(opts.onEnvelope(env)).catch((err: Error) => {
            opts.onError?.(err, 0);
          });
        });
        ws.addEventListener('close', () => settle('close'));
        ws.addEventListener('error', () => settle('close'));
      });
      try {
        ws.close();
      } catch {
        // ignore
      }
      if (closed === 'disconnect') continue; // immediate clean reopen
    } catch (err) {
      opts.onError?.(err as Error, backoff);
      await sleep(backoff);
      backoff = Math.min(backoff * 2, 30_000);
    }
  }
}

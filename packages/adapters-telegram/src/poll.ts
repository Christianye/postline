/**
 * Telegram getUpdates long-poll loop + offset management.
 *
 * The Bot API confirms updates by offset: each getUpdates call with
 * `offset = lastSeenUpdateId + 1` permanently acks everything below it.
 * We persist the offset in memory across the loop; on restart the bot
 * re-fetches from the server's earliest unconfirmed update (Telegram
 * holds them ~24h), so a brief restart doesn't lose messages but also
 * won't reprocess already-acked ones.
 */

import type { TelegramUpdate } from './parse.js';

export interface TelegramApiResponse<T> {
  ok: boolean;
  result?: T;
  error_code?: number;
  description?: string;
  parameters?: { retry_after?: number };
}

export interface PollLoopOptions {
  /** Bot token. */
  token: string;
  /** API base. Default `https://api.telegram.org`. Injectable for tests. */
  apiBase?: string;
  /** Long-poll timeout in seconds. Default 30. */
  timeoutSeconds?: number;
  /** fetch impl; defaults to global fetch. */
  fetcher?: typeof globalThis.fetch;
  /** Called for each received update. */
  onUpdate: (u: TelegramUpdate) => void | Promise<void>;
  /** Called on a poll error (network / non-ok). Best-effort logging hook. */
  onError?: (err: Error, retryAfterMs: number) => void;
  /** Returns true while the loop should keep running. */
  running: () => boolean;
  /** Sleeper; defaults to setTimeout. Injectable for tests. */
  sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_API_BASE = 'https://api.telegram.org';

/**
 * Run the long-poll loop until `running()` returns false. Resolves when
 * the loop stops. Each successful batch advances the offset; errors back
 * off (honouring `retry_after` on 429) without advancing.
 */
export async function runPollLoop(opts: PollLoopOptions): Promise<void> {
  const apiBase = opts.apiBase ?? DEFAULT_API_BASE;
  const fetcher = opts.fetcher ?? globalThis.fetch;
  const timeout = opts.timeoutSeconds ?? 30;
  const sleep = opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  let offset = 0;
  let backoff = 1000;

  while (opts.running()) {
    try {
      const url = `${apiBase}/bot${opts.token}/getUpdates`;
      const body = JSON.stringify({
        ...(offset > 0 ? { offset } : {}),
        timeout,
        allowed_updates: ['message', 'callback_query'],
      });
      const res = await fetcher(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
      });
      const json = (await res.json()) as TelegramApiResponse<TelegramUpdate[]>;
      if (!json.ok) {
        const retryAfter = (json.parameters?.retry_after ?? 1) * 1000;
        opts.onError?.(
          new Error(json.description ?? `telegram getUpdates ${res.status}`),
          retryAfter,
        );
        await sleep(retryAfter);
        continue;
      }
      backoff = 1000; // reset on success
      for (const u of json.result ?? []) {
        // Advance the offset past this update so it's acked next round.
        if (u.update_id >= offset) offset = u.update_id + 1;
        try {
          await opts.onUpdate(u);
        } catch {
          // a handler throw must not stall the loop or lose the offset
        }
      }
    } catch (err) {
      opts.onError?.(err as Error, backoff);
      await sleep(backoff);
      backoff = Math.min(backoff * 2, 30_000);
    }
  }
}

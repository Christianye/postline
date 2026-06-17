import { describe, expect, it } from 'vitest';
import { runPollLoop } from './poll.js';

function jsonResponse(body: unknown): Response {
  return { json: async () => body } as unknown as Response;
}

describe('runPollLoop', () => {
  it('advances the offset past received updates and delivers them', async () => {
    const seen: number[] = [];
    const offsets: Array<number | undefined> = [];
    let round = 0;
    const fetcher = (async (_url: string, init?: RequestInit) => {
      const body = JSON.parse((init?.body as string) ?? '{}');
      offsets.push(body.offset);
      round++;
      if (round === 1) {
        return jsonResponse({ ok: true, result: [{ update_id: 10 }, { update_id: 11 }] });
      }
      return jsonResponse({ ok: true, result: [] });
      // biome-ignore lint/suspicious/noExplicitAny: test fetcher stub
    }) as any;

    let calls = 0;
    await runPollLoop({
      token: 't',
      fetcher,
      sleep: async () => {},
      onUpdate: (u) => {
        seen.push(u.update_id);
      },
      running: () => calls++ < 2, // run exactly 2 rounds
    });

    expect(seen).toEqual([10, 11]);
    // First call has no offset; second call acks past update 11.
    expect(offsets[0]).toBeUndefined();
    expect(offsets[1]).toBe(12);
  });

  it('honours retry_after on a 429-style not-ok response without advancing', async () => {
    const sleeps: number[] = [];
    let round = 0;
    const fetcher = (async () => {
      round++;
      if (round === 1) {
        return jsonResponse({ ok: false, error_code: 429, parameters: { retry_after: 3 } });
      }
      return jsonResponse({ ok: true, result: [] });
      // biome-ignore lint/suspicious/noExplicitAny: test fetcher stub
    }) as any;

    let calls = 0;
    await runPollLoop({
      token: 't',
      fetcher,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      onUpdate: () => {},
      running: () => calls++ < 2,
    });

    expect(sleeps).toContain(3000); // retry_after seconds → ms
  });

  it('backs off exponentially on a thrown fetch error', async () => {
    const sleeps: number[] = [];
    const fetcher = (async () => {
      throw new Error('network down');
      // biome-ignore lint/suspicious/noExplicitAny: test fetcher stub
    }) as any;

    let calls = 0;
    await runPollLoop({
      token: 't',
      fetcher,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      onUpdate: () => {},
      running: () => calls++ < 3,
    });

    // 1s, then 2s (doubling)
    expect(sleeps[0]).toBe(1000);
    expect(sleeps[1]).toBe(2000);
  });

  it('surfaces a handler throw via onError but keeps the loop + offset', async () => {
    const errors: string[] = [];
    const offsets: Array<number | undefined> = [];
    let round = 0;
    const fetcher = (async (_url: string, init?: RequestInit) => {
      const body = JSON.parse((init?.body as string) ?? '{}');
      offsets.push(body.offset);
      round++;
      if (round === 1) return jsonResponse({ ok: true, result: [{ update_id: 5 }] });
      return jsonResponse({ ok: true, result: [] });
      // biome-ignore lint/suspicious/noExplicitAny: test fetcher stub
    }) as any;

    let calls = 0;
    await runPollLoop({
      token: 't',
      fetcher,
      sleep: async () => {},
      onUpdate: () => {
        throw new Error('handler boom');
      },
      onError: (err) => errors.push(err.message),
      running: () => calls++ < 2,
    });

    expect(errors).toContain('handler boom'); // surfaced, not swallowed
    expect(offsets[1]).toBe(6); // offset still advanced past the failed update
  });
});

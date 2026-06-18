import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { runKeeper } from './keeper.js';

const SECRET = 'POSTLINE_KEEPER_TEST_SECRET_32_BYTES_OPAQUE';

function sseFetcher(frames: string[]): typeof globalThis.fetch {
  return (async () => {
    const enc = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const f of frames) controller.enqueue(enc.encode(f));
        controller.close();
      },
    });
    return { ok: true, status: 200, body: stream } as unknown as Response;
    // biome-ignore lint/suspicious/noExplicitAny: test fetch stub
  }) as any;
}

/** running() true for the first connect, false after — so the reconnect
 *  loop runs exactly one SSE connection then exits (tests don't hang). */
function oneShot(): () => boolean {
  let n = 0;
  return () => n++ < 1;
}
const noSleep = async () => {};

function sse(obj: unknown): string {
  return `data: ${JSON.stringify(obj)}\n\n`;
}

/** spawn stub: records (bin, args, cwd); returns a never-exiting fake child. */
function spawnSpy() {
  const calls: Array<{ bin: string; args: string[]; cwd: string | undefined }> = [];
  const fn = ((bin: string, args: string[], opts?: { cwd?: string }) => {
    calls.push({ bin, args, cwd: opts?.cwd });
    const ee = new EventEmitter() as EventEmitter & { exitCode: number | null };
    ee.exitCode = null; // still running
    return ee;
    // biome-ignore lint/suspicious/noExplicitAny: minimal child stub
  }) as any;
  return { fn, calls };
}

describe('runKeeper', () => {
  it('starts a worker for a wake on an allowed repo', async () => {
    const spy = spawnSpy();
    const decisions: Array<{ action: string; cwd: string; kind: string }> = [];
    await runKeeper({
      doorbellUrl: 'http://x',
      secret: SECRET,
      repos: ['/repo/postline'],
      fetcher: sseFetcher([sse({ kind: 'wake', cwd: '/repo/postline', taskId: 'a1' })]),
      spawnChild: spy.fn,
      cliBin: 'postline',
      write: () => {},
      running: oneShot(),
      sleep: noSleep,
      onDecision: (d) => decisions.push(d),
    });
    expect(spy.calls.length).toBe(1);
    expect(spy.calls[0]).toMatchObject({ bin: 'postline', cwd: '/repo/postline' });
    expect(spy.calls[0]?.args).toEqual(['cc-worker', 'start']);
    expect(decisions[0]?.action).toBe('started');
  });

  it('passes --agent codex when the wake selector is codex', async () => {
    const spy = spawnSpy();
    await runKeeper({
      doorbellUrl: 'http://x',
      secret: SECRET,
      repos: ['/repo/postline'],
      fetcher: sseFetcher([
        sse({ kind: 'wake', cwd: '/repo/postline', selector: 'codex', taskId: 'a2' }),
      ]),
      spawnChild: spy.fn,
      write: () => {},
      running: oneShot(),
      sleep: noSleep,
    });
    expect(spy.calls[0]?.args).toEqual(['cc-worker', 'start', '--agent', 'codex']);
  });

  it('skips a wake for a repo NOT on the allowlist (security gate)', async () => {
    const spy = spawnSpy();
    const decisions: Array<{ action: string; reason?: string }> = [];
    await runKeeper({
      doorbellUrl: 'http://x',
      secret: SECRET,
      repos: ['/repo/postline'],
      fetcher: sseFetcher([sse({ kind: 'wake', cwd: '/repo/evil', taskId: 'a3' })]),
      spawnChild: spy.fn,
      write: () => {},
      running: oneShot(),
      sleep: noSleep,
      onDecision: (d) => decisions.push(d),
    });
    expect(spy.calls.length).toBe(0);
    expect(decisions[0]).toMatchObject({ action: 'skipped', reason: 'not_on_repo_allowlist' });
  });

  it('skips a second wake while a worker for the cwd is still running', async () => {
    const spy = spawnSpy();
    const decisions: Array<{ action: string; reason?: string }> = [];
    await runKeeper({
      doorbellUrl: 'http://x',
      secret: SECRET,
      repos: ['/repo/postline'],
      fetcher: sseFetcher([
        sse({ kind: 'wake', cwd: '/repo/postline', taskId: 'a4' }),
        sse({ kind: 'wake', cwd: '/repo/postline', taskId: 'a5' }),
      ]),
      spawnChild: spy.fn,
      write: () => {},
      running: oneShot(),
      sleep: noSleep,
      onDecision: (d) => decisions.push(d),
    });
    expect(spy.calls.length).toBe(1); // only the first wake spawned
    expect(decisions.map((d) => d.action)).toEqual(['started', 'skipped']);
    expect(decisions[1]?.reason).toBe('already_running');
  });

  it('starts a codex worker even while a cc worker for the same cwd is running', async () => {
    // Regression: `spawned` keyed by cwd alone made a codex wake report
    // already_running while a cc worker ran, so the codex task never drained.
    const spy = spawnSpy();
    const decisions: Array<{ action: string; kind: string }> = [];
    await runKeeper({
      doorbellUrl: 'http://x',
      secret: SECRET,
      repos: ['/repo/postline'],
      fetcher: sseFetcher([
        sse({ kind: 'wake', cwd: '/repo/postline', taskId: 'c1' }), // cc
        sse({ kind: 'wake', cwd: '/repo/postline', selector: 'codex', taskId: 'c2' }), // codex
      ]),
      spawnChild: spy.fn,
      write: () => {},
      running: oneShot(),
      sleep: noSleep,
      onDecision: (d) => decisions.push(d),
    });
    expect(spy.calls.length).toBe(2); // both kinds spawned
    expect(decisions.map((d) => d.action)).toEqual(['started', 'started']);
    expect(spy.calls[0]?.args).toEqual(['cc-worker', 'start']);
    expect(spy.calls[1]?.args).toEqual(['cc-worker', 'start', '--agent', 'codex']);
  });

  it('ignores non-wake events', async () => {
    const spy = spawnSpy();
    await runKeeper({
      doorbellUrl: 'http://x',
      secret: SECRET,
      repos: ['/repo/postline'],
      fetcher: sseFetcher([
        sse({ kind: 'snapshot', tasks: [] }),
        sse({ kind: 'progress', taskId: 'p1', cwd: '/repo/postline' }),
      ]),
      spawnChild: spy.fn,
      write: () => {},
      running: oneShot(),
      sleep: noSleep,
    });
    expect(spy.calls.length).toBe(0);
  });

  it('survives a worker spawn failure (ENOENT) — does not crash the keeper', async () => {
    // dogfood 2026-06-17: spawning a missing bin emits 'error'; without a
    // listener Node throws it unhandled and the keeper process dies.
    const decisions: Array<{ action: string; reason?: string }> = [];
    const failingSpawn = ((_bin: string, _args: string[]) => {
      const ee = new EventEmitter() as EventEmitter & { exitCode: number | null };
      ee.exitCode = null;
      queueMicrotask(() =>
        ee.emit('error', Object.assign(new Error('spawn x ENOENT'), { code: 'ENOENT' })),
      );
      return ee;
      // biome-ignore lint/suspicious/noExplicitAny: minimal child stub
    }) as any;
    await runKeeper({
      doorbellUrl: 'http://x',
      secret: SECRET,
      repos: ['/repo/postline'],
      fetcher: sseFetcher([sse({ kind: 'wake', cwd: '/repo/postline', taskId: 'e1' })]),
      spawnChild: failingSpawn,
      write: () => {},
      running: oneShot(),
      sleep: noSleep,
      onDecision: (d) => decisions.push(d),
    });
    // started (optimistic) then skipped:spawn_failed — keeper still returned.
    expect(decisions.some((d) => d.reason?.startsWith('spawn_failed'))).toBe(true);
  });

  it('reconnects after a failed connection (does not exit the process)', async () => {
    // First connect fails (bridge not up yet), keeper backs off + retries;
    // second connect delivers a wake. This is the resident-keeper fix: a
    // dropped/`terminated` SSE must reconnect, not kill the launchd unit.
    const spy = spawnSpy();
    let attempt = 0;
    const enc = new TextEncoder();
    const fetcher = (async () => {
      attempt++;
      if (attempt === 1) {
        return { ok: false, status: 503, body: null } as unknown as Response;
      }
      const stream = new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(enc.encode(sse({ kind: 'wake', cwd: '/repo/postline', taskId: 'r1' })));
          c.close();
        },
      });
      return { ok: true, status: 200, body: stream } as unknown as Response;
      // biome-ignore lint/suspicious/noExplicitAny: test fetch stub
    }) as any;
    const errors: string[] = [];
    // running: true for two outer iterations (fail, then success), then stop.
    let n = 0;
    await runKeeper({
      doorbellUrl: 'http://x',
      secret: SECRET,
      repos: ['/repo/postline'],
      fetcher,
      spawnChild: spy.fn,
      write: () => {},
      running: () => n++ < 2,
      sleep: noSleep,
      onError: (e) => errors.push(e.message),
    });
    expect(errors.length).toBe(1); // first attempt failed + was retried
    expect(spy.calls.length).toBe(1); // second attempt delivered the wake
  });
});

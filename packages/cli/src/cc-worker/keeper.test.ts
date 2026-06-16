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
      onDecision: (d) => decisions.push(d),
    });
    expect(spy.calls.length).toBe(1); // only the first wake spawned
    expect(decisions.map((d) => d.action)).toEqual(['started', 'skipped']);
    expect(decisions[1]?.reason).toBe('already_running');
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
    });
    expect(spy.calls.length).toBe(0);
  });
});

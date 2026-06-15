import { describe, expect, it } from 'vitest';
import { runWatch } from './watch.js';

const SECRET = 'POSTLINE_WATCH_TEST_SECRET_32_BYTES_OPAQUE';

/** Build a fetch stub whose body streams the given SSE frame strings. */
function sseFetcher(frames: string[]): typeof globalThis.fetch {
  return (async () => {
    const enc = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const f of frames) controller.enqueue(enc.encode(f));
        controller.close();
      },
    });
    return {
      ok: true,
      status: 200,
      body: stream,
    } as unknown as Response;
    // biome-ignore lint/suspicious/noExplicitAny: minimal fetch stub
  }) as any;
}

function sse(obj: unknown): string {
  return `data: ${JSON.stringify(obj)}\n\n`;
}

describe('runWatch — plain mode', () => {
  it('renders snapshot, progress, terminal lines from the SSE stream', async () => {
    const out: string[] = [];
    await runWatch({
      doorbellUrl: 'http://x',
      secret: SECRET,
      plain: true,
      write: (s) => out.push(s),
      fetcher: sseFetcher([
        sse({
          kind: 'snapshot',
          tasks: [{ taskId: 'a1', cwd: '/repo/postline', status: 'running' }],
        }),
        sse({
          kind: 'progress',
          taskId: 'a1',
          cwd: '/repo/postline',
          responder: 'cc@postline · mac',
          event: { kind: 'tool', label: 'Bash: pnpm test' },
        }),
        sse({ kind: 'terminal', taskId: 'a1', cwd: '/repo/postline', status: 'done' }),
      ]),
    });
    const joined = out.join('');
    expect(joined).toContain('[snapshot] 1 in-flight');
    expect(joined).toContain('[progress] #a1 cc@postline · mac');
    expect(joined).toContain('Bash: pnpm test');
    expect(joined).toContain('[done] #a1');
  });

  it('handles a frame split across chunk boundaries', async () => {
    const out: string[] = [];
    const full = sse({ kind: 'snapshot', tasks: [] });
    const mid = Math.floor(full.length / 2);
    await runWatch({
      doorbellUrl: 'http://x',
      secret: SECRET,
      plain: true,
      write: (s) => out.push(s),
      fetcher: sseFetcher([full.slice(0, mid), full.slice(mid)]),
    });
    expect(out.join('')).toContain('[snapshot] 0 in-flight');
  });

  it('reports a failed connection', async () => {
    const out: string[] = [];
    const fetcher = (async () =>
      ({ ok: false, status: 401, body: null }) as unknown as Response) as unknown as typeof fetch;
    await runWatch({
      doorbellUrl: 'http://x',
      secret: SECRET,
      plain: true,
      write: (s) => out.push(s),
      fetcher,
    });
    expect(out.join('')).toContain('failed to connect (401)');
  });
});

describe('runWatch — TUI mode', () => {
  it('renders a redraw frame listing in-flight tasks', async () => {
    const out: string[] = [];
    await runWatch({
      doorbellUrl: 'http://x',
      secret: SECRET,
      plain: false,
      write: (s) => out.push(s),
      fetcher: sseFetcher([
        sse({
          kind: 'snapshot',
          tasks: [
            {
              taskId: 'b2',
              cwd: '/repo/neugate',
              status: 'running',
              responder: 'cc@neugate · ec2',
            },
          ],
        }),
        sse({
          kind: 'progress',
          taskId: 'b2',
          cwd: '/repo/neugate',
          event: { kind: 'tool', label: 'Read: x.ts' },
        }),
      ]),
    });
    const last = out[out.length - 1] ?? '';
    expect(last).toContain('postline · live');
    expect(last).toContain('#b2');
    expect(last).toContain('cc@neugate · ec2');
    expect(last).toContain('Read: x.ts');
  });
});

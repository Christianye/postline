import { sign } from '@postline/doorbell';
import type { WatchEvent, WatchTask } from '@postline/doorbell';

/**
 * `cc-worker watch` — read-only live view of in-flight tasks across the
 * bridge, fed by the doorbell `GET /watch` SSE stream (PR-OBS-2).
 *
 * Renders all in-flight tasks + a rolling activity line per task. Two
 * modes: a redrawing TUI (default) and `--plain` (append-only, pipe- and
 * scrollback-friendly). Zero deps — plain ANSI, no ink/blessed.
 */

export interface WatchOptions {
  doorbellUrl: string;
  secret: string;
  plain: boolean;
  /** Injected for tests. */
  fetcher?: typeof globalThis.fetch;
  /** Where to write frames. Default process.stdout.write. */
  write?: (s: string) => void;
  /** Returns false to stop (tests). Default never stops. */
  running?: () => boolean;
}

interface TaskView {
  taskId: string;
  cwd: string;
  status: string;
  responder?: string;
  lastActivity?: string;
}

/**
 * Connect to GET /watch and stream events, rendering as they arrive.
 * Resolves when the stream closes (or `running()` turns false).
 */
export async function runWatch(opts: WatchOptions): Promise<void> {
  const fetcher = opts.fetcher ?? globalThis.fetch;
  const write = opts.write ?? ((s: string) => void process.stdout.write(s));
  const running = opts.running ?? (() => true);

  const path = '/watch';
  const ts = Date.now();
  const sig = sign({ method: 'GET', path, body: '', ts, secret: opts.secret });

  const res = await fetcher(`${opts.doorbellUrl}${path}`, {
    method: 'GET',
    headers: {
      accept: 'text/event-stream',
      'x-doorbell-ts': String(ts),
      'x-doorbell-signature': sig,
    },
  });
  if (!res.ok || !res.body) {
    write(`watch: failed to connect (${res.status})\n`);
    return;
  }

  const tasks = new Map<string, TaskView>();
  const render = () => {
    if (opts.plain) return; // plain mode renders per-event, not full-frame
    write(renderFrame(tasks));
  };

  const onEvent = (e: WatchEvent) => {
    applyEvent(tasks, e);
    if (opts.plain) write(`${plainLine(e)}\n`);
    else render();
  };

  // Parse the SSE byte stream: `data: <json>\n\n` frames, `:`-comments ignored.
  const reader = (res.body as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  let buf = '';
  while (running()) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx = buf.indexOf('\n\n');
    while (idx >= 0) {
      const frame = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      for (const line of frame.split('\n')) {
        if (line.startsWith('data:')) {
          const json = line.slice(5).trim();
          if (json) {
            try {
              onEvent(JSON.parse(json) as WatchEvent);
            } catch {
              // skip malformed frame
            }
          }
        }
      }
      idx = buf.indexOf('\n\n');
    }
  }
}

function applyEvent(tasks: Map<string, TaskView>, e: WatchEvent): void {
  if (e.kind === 'snapshot') {
    tasks.clear();
    for (const t of e.tasks) tasks.set(t.taskId, toView(t));
    return;
  }
  if (e.kind === 'progress') {
    const v = tasks.get(e.taskId) ?? {
      taskId: e.taskId,
      cwd: e.cwd,
      status: 'running',
    };
    v.status = 'running';
    if (e.responder) v.responder = e.responder;
    if (e.event) {
      const icon = e.event.kind === 'tool' ? '🔧' : e.event.kind === 'thinking' ? '💭' : '·';
      v.lastActivity = e.event.kind === 'text' ? e.event.label : `${icon} ${e.event.label}`;
    } else if (e.summary) {
      v.lastActivity = e.summary;
    }
    tasks.set(e.taskId, v);
    return;
  }
  if (e.kind === 'terminal') {
    tasks.delete(e.taskId);
    return;
  }
  // worker register/remove events don't change the task table; ignored in
  // the table view (surfaced in plain mode only).
}

function toView(t: WatchTask): TaskView {
  return {
    taskId: t.taskId,
    cwd: t.cwd,
    status: t.status,
    ...(t.responder ? { responder: t.responder } : {}),
  };
}

const CLEAR = '\x1b[2J\x1b[H';

function renderFrame(tasks: Map<string, TaskView>): string {
  const lines: string[] = [`${CLEAR}┌─ postline · live ─────────────────────────────`];
  if (tasks.size === 0) {
    lines.push('│ (no in-flight tasks)');
  } else {
    for (const v of tasks.values()) {
      const who = v.responder ?? basename(v.cwd);
      lines.push(`│ #${v.taskId}  ${who}  ${v.status}`);
      if (v.lastActivity) lines.push(`│   ${clip(v.lastActivity, 60)}`);
    }
  }
  lines.push('└────────────────────────────────────────────────');
  return `${lines.join('\n')}\n`;
}

function plainLine(e: WatchEvent): string {
  switch (e.kind) {
    case 'snapshot':
      return `[snapshot] ${e.tasks.length} in-flight`;
    case 'progress': {
      const act = e.event ? `${e.event.kind}:${e.event.label}` : (e.summary ?? '');
      return `[progress] #${e.taskId} ${e.responder ?? e.cwd} ${clip(act, 80)}`;
    }
    case 'terminal':
      return `[${e.status}] #${e.taskId} ${e.cwd}${e.errorMessage ? ` — ${e.errorMessage}` : ''}`;
    case 'worker':
      return `[worker ${e.action}] ${e.agentKind ?? 'cc'}@${basename(e.cwd)} · ${e.hostname}`;
  }
}

function basename(p: string): string {
  return p.split('/').filter(Boolean).pop() ?? p;
}

function clip(s: string, n: number): string {
  const oneLine = s.replace(/\s+/g, ' ').trim();
  return oneLine.length > n ? `${oneLine.slice(0, n)}…` : oneLine;
}

import { type ChildProcess, spawn } from 'node:child_process';
import { sign } from '@postline/doorbell';
import type { WatchEvent } from '@postline/doorbell';

/**
 * `cc-worker keeper` — per-host supervisor for auto-default-worker (C2).
 *
 * Subscribes to the doorbell `GET /watch` SSE stream and, on a `wake`
 * event for a cwd this host owns, starts a `cc-worker` for it. The bridge
 * never spawns (RF2): it only emits the wake intent; this keeper — running
 * on the host that actually has the repo + tools + creds — decides whether
 * to act.
 *
 * Two security gates (auto-default-worker RFC RFW4):
 *   1. The bridge only emits `wake` for dispatches from allowlisted senders
 *      (enforced bridge-side, before enqueue).
 *   2. The keeper only starts a worker for a cwd on its OWN allowlist
 *      (`--repo <cwd>` flags / CC_KEEPER_REPOS) — never an arbitrary cwd
 *      from the wire.
 *
 * Idempotent: a wake for a cwd that already has a keeper-spawned worker
 * still running is ignored (one worker per cwd per kind).
 */

export interface KeeperOptions {
  doorbellUrl: string;
  secret: string;
  /** Absolute cwds this host is allowed to auto-start workers for. */
  repos: readonly string[];
  /** Default agent kind when a wake carries no selector. Default 'cc'. */
  defaultAgentKind?: string;
  /** Path to the postline CLI bin to spawn (`<bin> cc-worker start …`). */
  cliBin?: string;
  /** Injected for tests. */
  fetcher?: typeof globalThis.fetch;
  spawnChild?: typeof spawn;
  write?: (s: string) => void;
  running?: () => boolean;
  /** Notified after a spawn decision (started / skipped) — for tests + logs. */
  onDecision?: (d: {
    cwd: string;
    kind: string;
    action: 'started' | 'skipped';
    reason?: string;
  }) => void;
}

interface RunningWorker {
  child: ChildProcess;
  kind: string;
}

/**
 * Run the keeper loop: connect to /watch, act on `wake` events. Resolves
 * when the stream closes or `running()` turns false.
 */
export async function runKeeper(opts: KeeperOptions): Promise<void> {
  const fetcher = opts.fetcher ?? globalThis.fetch;
  const spawner = opts.spawnChild ?? spawn;
  const write = opts.write ?? ((s: string) => void process.stderr.write(s));
  const running = opts.running ?? (() => true);
  const cliBin = opts.cliBin ?? 'postline';
  const allowed = new Set(opts.repos);
  // cwd → running worker we spawned (per cwd; kind tracked for logging).
  const spawned = new Map<string, RunningWorker>();

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
    write(`keeper: failed to connect to doorbell (${res.status})\n`);
    return;
  }
  write(`keeper: watching for wake intents · repos: ${[...allowed].join(', ') || '(none!)'}\n`);

  const onWake = (cwd: string, kind: string, taskId: string): void => {
    if (!allowed.has(cwd)) {
      opts.onDecision?.({ cwd, kind, action: 'skipped', reason: 'not_on_repo_allowlist' });
      return;
    }
    const existing = spawned.get(cwd);
    if (existing && existing.child.exitCode === null) {
      opts.onDecision?.({ cwd, kind, action: 'skipped', reason: 'already_running' });
      return;
    }
    // Start a worker for this cwd. It registers with the doorbell, the held
    // task drains to it. The worker runs in `cwd`; agent kind from the wake.
    const args = ['cc-worker', 'start'];
    if (kind === 'codex') args.push('--agent', 'codex');
    const child = spawner(cliBin, args, { cwd, stdio: 'ignore', detached: false });
    spawned.set(cwd, { child, kind });
    child.on('exit', () => {
      if (spawned.get(cwd)?.child === child) spawned.delete(cwd);
    });
    write(`keeper: started ${kind} worker for ${cwd} (wake #${taskId})\n`);
    opts.onDecision?.({ cwd, kind, action: 'started' });
  };

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
        if (!line.startsWith('data:')) continue;
        const json = line.slice(5).trim();
        if (!json) continue;
        let e: WatchEvent | null = null;
        try {
          e = JSON.parse(json) as WatchEvent;
        } catch {
          continue;
        }
        if (e.kind === 'wake') {
          onWake(e.cwd, e.selector ?? opts.defaultAgentKind ?? 'cc', e.taskId);
        }
      }
      idx = buf.indexOf('\n\n');
    }
  }
}

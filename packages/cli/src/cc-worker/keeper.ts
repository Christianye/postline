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
  /**
   * Binary to spawn the worker with. Default `'postline'` (assumes a global
   * install). When postline isn't on PATH, set this to the node binary and
   * pass `cliPrefixArgs: [<bin.js path>]` so the keeper runs
   * `node <bin.js> cc-worker start`.
   */
  cliBin?: string;
  /** Args inserted before `cc-worker start` (e.g. the bin.js path for `node`). */
  cliPrefixArgs?: readonly string[];
  /** Injected for tests. */
  fetcher?: typeof globalThis.fetch;
  spawnChild?: typeof spawn;
  write?: (s: string) => void;
  running?: () => boolean;
  /** Sleeper for reconnect backoff; defaults to setTimeout. */
  sleep?: (ms: number) => Promise<void>;
  /** Notified on a connect/read failure before backoff (tests + logs). */
  onError?: (err: Error, retryMs: number) => void;
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

  const sleep = opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
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
    const args = [...(opts.cliPrefixArgs ?? []), 'cc-worker', 'start'];
    if (kind === 'codex') args.push('--agent', 'codex');
    const child = spawner(cliBin, args, { cwd, stdio: 'ignore', detached: false });
    spawned.set(cwd, { child, kind });
    // A spawn failure (e.g. ENOENT — cliBin not on PATH) emits 'error'.
    // WITHOUT this listener Node throws it as an unhandled exception and
    // the whole keeper process dies (dogfood 2026-06-17). Catch it, drop
    // the slot, and keep the keeper alive.
    child.on('error', (err: Error) => {
      if (spawned.get(cwd)?.child === child) spawned.delete(cwd);
      write(`keeper: failed to start worker for ${cwd}: ${err.message}\n`);
      opts.onDecision?.({ cwd, kind, action: 'skipped', reason: `spawn_failed:${err.message}` });
    });
    child.on('exit', () => {
      if (spawned.get(cwd)?.child === child) spawned.delete(cwd);
    });
    write(`keeper: started ${kind} worker for ${cwd} (wake #${taskId})\n`);
    opts.onDecision?.({ cwd, kind, action: 'started' });
  };

  // One SSE connection: connect, read frames until the stream ends/errors.
  // Returns normally on a clean end; throws on connect/read failure so the
  // reconnect loop can back off.
  const connectOnce = async (): Promise<void> => {
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
    if (!res.ok || !res.body) throw new Error(`watch connect ${res.status}`);
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    let buf = '';
    // Read until the stream ends (done) or errors. Reconnect is the outer
    // loop's job — don't gate the per-frame read on running().
    for (;;) {
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
  };

  // Reconnect loop: the SSE long-poll gets `terminated` by the platform
  // fetch on idle/long runs, and the bridge may not be up yet at boot. Keep
  // reconnecting with bounded backoff instead of exiting (which would make
  // launchd thrash-restart the whole process).
  let backoff = 1000;
  while (running()) {
    try {
      await connectOnce();
      backoff = 1000; // clean end → reconnect promptly
    } catch (err) {
      opts.onError?.(err as Error, backoff);
      await sleep(backoff);
      backoff = Math.min(backoff * 2, 30_000);
      continue;
    }
    await sleep(500); // clean end (stream closed) — brief pause then reconnect
  }
}

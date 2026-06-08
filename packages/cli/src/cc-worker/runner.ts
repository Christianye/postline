import { type ChildProcess, spawn } from 'node:child_process';
import type { Logger } from '@postline/core';
import { sign } from '@postline/doorbell';

/**
 * cc-worker runner.
 *
 * Lifecycle:
 *  1. POST /mac/register with {host, cwd, pid}.
 *  2. Long-poll loop: GET /mac/poll → 200 task | 204 idle | 401/409.
 *  3. On 200: spawn `claude -p <prompt>` with the headless preamble
 *     (per design §PR-DB-3 Headless invariants), pipe stdout debounced
 *     to /mac/progress, on exit POST /mac/result with status: ok |
 *     failed | timeout | killed.
 *  4. On 401/409: re-register (after backoff).
 *  5. On network/5xx: exponential backoff 1s → 2 → 5 → 10 → 30 cap.
 *
 * The runner is **not** a daemon by itself — it runs in the foreground
 * of `postline cc-worker start`, which is what the operator invokes
 * from a terminal where Claude Code is already open. Closing the
 * terminal (or Ctrl-C) is the natural stop signal; we also handle
 * SIGTERM for `cc-worker stop`.
 *
 * Network IO + child-process spawning are passed in via deps so the
 * unit tests can pin the runner against in-memory fakes. Production
 * builds default to real `fetch` and real `spawn`.
 */

export interface RunnerDeps {
  /** HTTP client. Defaults to global fetch in production. */
  fetch?: typeof globalThis.fetch;
  /** Spawner for headless Claude Code. Defaults to node's child_process.spawn. */
  spawnChild?: typeof spawn;
  /** Clock; tests pass a deterministic source. */
  now?: () => number;
  /** Sleeper; tests pass a vi-controlled timer. */
  sleep?: (ms: number) => Promise<void>;
}

export interface RunnerOptions {
  /** Base URL of the doorbell server, e.g. `http://localhost:9999`. */
  doorbellUrl: string;
  /** 32+ char shared secret. */
  secret: string;
  /** Canonical cwd of this worker. */
  cwd: string;
  /** Reporting hostname. */
  host: string;
  /** Process id of the runner. */
  pid: number;
  /** Path to the claude binary. Default `'claude'` (PATH-resolved). */
  claudeBin?: string;
  /** Long-poll timeout in ms. Default 30_000 (matches server default). */
  longPollTimeoutMs?: number;
  /** Per-task headless deadline in ms. Default 5min. */
  taskDeadlineMs?: number;
  /** Progress POST debounce in ms. Default 5_000. */
  progressDebounceMs?: number;
  /**
   * Headless preamble injected before the user's prompt. Default
   * encodes the §PR-DB-3 Headless invariants.
   */
  headlessPreamble?: string;
  log: Logger;
  deps?: RunnerDeps;
}

export interface RegisterResult {
  workerId: string;
  state: 'active' | 'standby';
}

/** POST /mac/register. Returns the assigned workerId or throws on failure. */
export async function registerWorker(opts: RunnerOptions): Promise<RegisterResult> {
  const fetcher = opts.deps?.fetch ?? globalThis.fetch;
  const body = JSON.stringify({
    cwd: opts.cwd,
    hostname: opts.host,
    pid: opts.pid,
    registeredAt: opts.deps?.now ? opts.deps.now() : Date.now(),
  });
  const path = '/mac/register';
  const ts = opts.deps?.now ? opts.deps.now() : Date.now();
  const sig = sign({ method: 'POST', path, body, ts, secret: opts.secret });
  const res = await fetcher(`${opts.doorbellUrl}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-doorbell-ts': String(ts),
      'x-doorbell-signature': sig,
    },
    body,
  });
  if (res.status !== 200) {
    const text = await res.text().catch(() => '');
    throw new Error(`register failed: ${res.status} ${text.slice(0, 200)}`);
  }
  const json = (await res.json()) as RegisterResult;
  return json;
}

export interface PollResult {
  /** 200 + task body. */
  task?: {
    taskId: string;
    prompt: string;
    cwd: string;
    deadlineMs: number;
    retryCount: number;
  };
  /** 204 / non-200 outcome. */
  status: 'task' | 'idle' | 'unknown_worker' | 'demoted' | 'standby' | 'error';
  errorBody?: unknown;
}

/** GET /mac/poll. Holds for up to longPollTimeoutMs server-side. */
export async function pollOnce(opts: RunnerOptions, workerId: string): Promise<PollResult> {
  const fetcher = opts.deps?.fetch ?? globalThis.fetch;
  const path = `/mac/poll?workerId=${encodeURIComponent(workerId)}`;
  const ts = opts.deps?.now ? opts.deps.now() : Date.now();
  const sig = sign({ method: 'GET', path, body: '', ts, secret: opts.secret });
  const res = await fetcher(`${opts.doorbellUrl}${path}`, {
    method: 'GET',
    headers: {
      'x-doorbell-ts': String(ts),
      'x-doorbell-signature': sig,
    },
  });
  if (res.status === 200) {
    const task = (await res.json()) as PollResult['task'];
    return { status: 'task', ...(task ? { task } : {}) };
  }
  if (res.status === 204) return { status: 'idle' };
  if (res.status === 401) return { status: 'unknown_worker' };
  if (res.status === 409) {
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      // ignore
    }
    if (body && typeof body === 'object' && 'status' in body && body.status === 'demoted') {
      return { status: 'demoted', errorBody: body };
    }
    return { status: 'standby', errorBody: body };
  }
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    // ignore
  }
  return { status: 'error', errorBody: body };
}

export interface ProgressBody {
  taskId: string;
  workerId: string;
  summary?: string;
  etaSeconds?: number;
}

export async function postProgress(opts: RunnerOptions, body: ProgressBody): Promise<void> {
  await postSigned(opts, '/mac/progress', body);
}

export interface ResultBody {
  taskId: string;
  workerId: string;
  status: 'ok' | 'failed' | 'killed' | 'timeout';
  text?: string;
  errorMessage?: string;
}

export async function postResult(opts: RunnerOptions, body: ResultBody): Promise<void> {
  await postSigned(opts, '/mac/result', body);
}

async function postSigned(
  opts: RunnerOptions,
  path: string,
  body: ProgressBody | ResultBody,
): Promise<void> {
  const fetcher = opts.deps?.fetch ?? globalThis.fetch;
  const bodyText = JSON.stringify(body);
  const ts = opts.deps?.now ? opts.deps.now() : Date.now();
  const sig = sign({ method: 'POST', path, body: bodyText, ts, secret: opts.secret });
  const res = await fetcher(`${opts.doorbellUrl}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-doorbell-ts': String(ts),
      'x-doorbell-signature': sig,
    },
    body: bodyText,
  });
  if (res.status !== 200) {
    const text = await res.text().catch(() => '');
    opts.log.warn(
      { path, status: res.status, snippet: text.slice(0, 200) },
      'cc_worker_post_failed',
    );
  }
}

const DEFAULT_PREAMBLE = [
  'You are running headless on behalf of postline-the-bridge.',
  '',
  'If you predict total runtime > 30s, emit exactly `<eta>SECS</eta>` on a',
  'line by itself before any tool calls. Otherwise emit nothing for the',
  'ETA tag. Then proceed with the user request below.',
  '',
  '---',
  '',
].join('\n');

export interface RunOnceParams {
  opts: RunnerOptions;
  workerId: string;
  task: NonNullable<PollResult['task']>;
}

/**
 * Run a single dispatched task: spawn `claude -p`, pipe stdout to
 * progress (debounced), POST result on exit. Returns the final result
 * payload so callers can decide whether to keep polling.
 */
export async function runTask(params: RunOnceParams): Promise<ResultBody> {
  const { opts, workerId, task } = params;
  const spawner = opts.deps?.spawnChild ?? spawn;
  const claudeBin = opts.claudeBin ?? 'claude';
  const preamble = opts.headlessPreamble ?? DEFAULT_PREAMBLE;
  const composedPrompt = `${preamble}${task.prompt}`;

  let stdoutBuf = '';
  let stderrBuf = '';
  let etaReported = false;
  const debounceMs = opts.progressDebounceMs ?? 5_000;
  let lastProgressPost = 0;
  let killed = false;

  const child: ChildProcess = spawner(claudeBin, ['-p', composedPrompt], {
    stdio: ['ignore', 'pipe', 'pipe'],
    cwd: opts.cwd,
  });

  const tryEtaParse = (text: string): number | null => {
    if (etaReported) return null;
    // Whitelist-strict per design §4 PR-DB-4: alone-on-line, before
    // tool calls. Here at the worker side we apply a slightly relaxed
    // form (single-line) since the server enforces the strict shape.
    const m = /(?:^|\n)\s*<eta>(\d+)<\/eta>\s*(?:\n|$)/.exec(text);
    if (!m || !m[1]) return null;
    const secs = Number.parseInt(m[1], 10);
    if (!Number.isFinite(secs) || secs <= 0 || secs > 3600) return null;
    etaReported = true;
    return secs;
  };

  const pushProgress = async (force = false): Promise<void> => {
    const now = opts.deps?.now ? opts.deps.now() : Date.now();
    if (!force && now - lastProgressPost < debounceMs) return;
    lastProgressPost = now;
    const summary = stdoutBuf.split('\n').slice(-3).join('\n').slice(0, 600);
    const eta = tryEtaParse(stdoutBuf);
    await postProgress(opts, {
      taskId: task.taskId,
      workerId,
      ...(summary ? { summary } : {}),
      ...(eta !== null ? { etaSeconds: eta } : {}),
    });
  };

  child.stdout?.on('data', (chunk: Buffer) => {
    stdoutBuf += chunk.toString('utf8');
    void pushProgress();
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    stderrBuf += chunk.toString('utf8');
  });

  const deadline = task.deadlineMs;
  let timer: NodeJS.Timeout | null = null;
  if (deadline > 0) {
    const ms = Math.max(0, deadline - (opts.deps?.now ? opts.deps.now() : Date.now()));
    timer = setTimeout(() => {
      killed = true;
      try {
        child.kill('SIGTERM');
      } catch {
        // ignore
      }
    }, ms);
    if (typeof timer.unref === 'function') timer.unref();
  }

  const exitCode: number | null = await new Promise((resolve) => {
    child.on('exit', (code) => resolve(code));
    child.on('error', () => resolve(null));
  });
  if (timer) clearTimeout(timer);

  // Flush a final progress post (force) before sending the result so
  // the IM UX doesn't lose the tail of the output.
  try {
    await pushProgress(true);
  } catch {
    // ignore
  }

  let resultBody: ResultBody;
  if (killed) {
    resultBody = {
      taskId: task.taskId,
      workerId,
      status: 'timeout',
      text: stdoutBuf,
      errorMessage: 'task exceeded deadline',
    };
  } else if (exitCode === 0) {
    resultBody = { taskId: task.taskId, workerId, status: 'ok', text: stdoutBuf };
  } else if (exitCode === null) {
    resultBody = {
      taskId: task.taskId,
      workerId,
      status: 'killed',
      text: stdoutBuf,
      errorMessage: 'spawn failed',
    };
  } else {
    resultBody = {
      taskId: task.taskId,
      workerId,
      status: 'failed',
      text: stdoutBuf,
      errorMessage: `exit ${exitCode}: ${stderrBuf.slice(-500)}`,
    };
  }
  try {
    await postResult(opts, resultBody);
  } catch (err) {
    opts.log.warn({ err: (err as Error).message }, 'cc_worker_result_post_error');
  }
  return resultBody;
}

/**
 * Sleep with exponential backoff capped at 30s.
 *
 * Sequence: 1s → 2 → 5 → 10 → 30 → 30 → ...
 */
export function backoffMs(attempt: number): number {
  const ladder = [1_000, 2_000, 5_000, 10_000, 30_000];
  if (attempt < 0) return 0;
  if (attempt >= ladder.length) return 30_000;
  return ladder[attempt] ?? 30_000;
}

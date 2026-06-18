import { type IncomingMessage, type Server, type ServerResponse, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Logger } from '@postline/core';
import type { DoorbellCoordinator } from './coordinator.js';
import { verify } from './hmac.js';
import type {
  DemotedError,
  ProgressEvent,
  QueueFullError,
  Task,
  TaskId,
  TaskStatus,
  WorkerId,
  WorkerRegistration,
} from './types.js';

/**
 * Doorbell HTTP server — bind to 127.0.0.1:9999 by default per design
 * §6.1 (SSM-tunneled, no public ingress).
 *
 * v1 ships a SYNCHRONOUS long-poll endpoint: `/mac/poll` returns
 * immediately with 200 (task) / 204 (idle) / 4xx. The actual hold-30s
 * long-poll behaviour from §4.0 lands in the next commit on top of this
 * scaffold; until then poll-on-empty returns 204 right away. This split
 * keeps the wire-protocol auth + task-flow happy path testable without
 * timer/Promise dance interfering.
 */

export interface DoorbellServerOptions {
  coordinator: DoorbellCoordinator;
  /** 32+ char shared secret per design §6.2. */
  secret: string;
  /** Listen host. Default 127.0.0.1 (no public ingress). */
  host?: string;
  /** Listen port. Default 9999. */
  port?: number;
  /** Allowed clock-skew window for HMAC ts header. Default 60_000. */
  hmacWindowMs?: number;
  /**
   * Long-poll hold timeout in ms (design §4.0). Default 30_000. After
   * this with no task, the server responds 204 and the worker
   * reconnects.
   */
  longPollTimeoutMs?: number;
  /**
   * Audit hook for first-time hostname registrations. Per design §6.2:
   * any time a worker registers from a hostname we've never seen
   * before, fire this hook (typically Feishu-DMs the operator) so a
   * leaked secret showing up from an unfamiliar host is visible.
   * Subsequent registrations from the same hostname don't re-fire.
   */
  onFirstHostnameSeen?: (params: {
    hostname: string;
    workerId: string;
    cwd: string;
    pid: number;
  }) => void;
  log: Logger;
}

export interface DoorbellServerHandle {
  /** Address the server is bound to (resolves the 0 port if used in tests). */
  address: { host: string; port: number };
  /** Stop accepting new connections + close. */
  close(): Promise<void>;
}

export async function startDoorbellServer(
  opts: DoorbellServerOptions,
): Promise<DoorbellServerHandle> {
  const log = opts.log.child({ component: 'doorbell_server' });
  const host = opts.host ?? '127.0.0.1';
  const port = opts.port ?? 9999;
  const seenHostnames = new Set<string>();

  const server = createServer((req, res) => {
    handleRequest(req, res, opts, log, seenHostnames).catch((err) => {
      log.error({ err: (err as Error).message }, 'doorbell_unhandled');
      if (!res.headersSent) writeJson(res, 500, { error: 'internal' });
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.removeListener('error', reject);
      resolve();
    });
  });

  const addr = server.address() as AddressInfo;
  log.info({ host: addr.address, port: addr.port }, 'doorbell_listening');

  return {
    address: { host: addr.address, port: addr.port },
    close: () => closeServer(server),
  };
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  opts: DoorbellServerOptions,
  log: Logger,
  seenHostnames: Set<string>,
): Promise<void> {
  const method = (req.method ?? 'GET').toUpperCase();
  const path = req.url ?? '/';
  let body: string;
  try {
    body = await readBody(req);
  } catch (err) {
    // Body exceeded the cap (pre-auth memory-exhaustion guard). Reject.
    if ((err as { code?: string }).code === 'BODY_TOO_LARGE') {
      writeJson(res, 413, { error: 'payload_too_large' });
      return;
    }
    writeJson(res, 400, { error: 'bad_request' });
    return;
  }

  // HMAC auth runs for every endpoint; return shape mirrors design §6.2.
  const auth = verify({
    method,
    path,
    body,
    tsHeader: stringHeader(req, 'x-doorbell-ts'),
    signatureHeader: stringHeader(req, 'x-doorbell-signature'),
    secret: opts.secret,
    ...(opts.hmacWindowMs !== undefined ? { windowMs: opts.hmacWindowMs } : {}),
  });
  if (!auth.ok) {
    const status =
      auth.reason === 'missing_header' || auth.reason === 'malformed_ts'
        ? 400
        : auth.reason === 'ts_skew'
          ? 403
          : 401;
    log.warn(
      { event: 'doorbell_audit', kind: 'auth_rejected', reason: auth.reason, path, method },
      'doorbell_auth_rejected',
    );
    writeJson(res, status, { error: auth.reason });
    return;
  }

  if (method === 'POST' && path === '/mac/register') {
    return handleRegister(req, res, opts, body, log, seenHostnames);
  }
  if (method === 'GET' && path.startsWith('/mac/poll')) {
    return handlePoll(req, res, opts, log);
  }
  if (method === 'POST' && path === '/mac/progress') {
    return handleProgress(req, res, opts, body, log);
  }
  if (method === 'POST' && path === '/mac/result') {
    return handleResult(req, res, opts, body, log);
  }
  if (method === 'GET' && path === '/watch') {
    return handleWatch(req, res, opts, log);
  }
  writeJson(res, 404, { error: 'not_found' });
}

async function handleRegister(
  _req: IncomingMessage,
  res: ServerResponse,
  opts: DoorbellServerOptions,
  body: string,
  log: Logger,
  seenHostnames: Set<string>,
): Promise<void> {
  const parsed = parseJson<WorkerRegistration>(body);
  if (!parsed) return writeJson(res, 400, { error: 'malformed_body' });
  if (!parsed.cwd || !parsed.hostname || typeof parsed.pid !== 'number') {
    return writeJson(res, 400, { error: 'missing_fields' });
  }
  const out = opts.coordinator.register({
    cwd: parsed.cwd,
    hostname: parsed.hostname,
    ...(parsed.agentKind ? { agentKind: parsed.agentKind } : {}),
    pid: parsed.pid,
    registeredAt: parsed.registeredAt ?? Date.now(),
  });
  log.info(
    {
      event: 'doorbell_audit',
      kind: 'register',
      workerId: out.workerId,
      cwd: parsed.cwd,
      hostname: parsed.hostname,
      pid: parsed.pid,
    },
    'doorbell_register',
  );
  // First-time-hostname-seen audit. The set is in-memory only; on a
  // bridge restart every hostname is "first-time" again, which is fine —
  // the operator gets a fresh notification on restart and that's a
  // useful signal that the bridge bounced.
  if (!seenHostnames.has(parsed.hostname)) {
    seenHostnames.add(parsed.hostname);
    try {
      opts.onFirstHostnameSeen?.({
        hostname: parsed.hostname,
        workerId: out.workerId,
        cwd: parsed.cwd,
        pid: parsed.pid,
      });
    } catch (err) {
      log.warn({ err: (err as Error).message }, 'doorbell_first_hostname_hook_error');
    }
  }
  writeJson(res, 200, { workerId: out.workerId, state: out.state });
}

function handlePoll(
  req: IncomingMessage,
  res: ServerResponse,
  opts: DoorbellServerOptions,
  log: Logger,
): void {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  const workerId = url.searchParams.get('workerId');
  if (!workerId) {
    writeJson(res, 400, { error: 'missing_workerId' });
    return;
  }
  const worker = opts.coordinator.registry.get(workerId);
  if (!worker) {
    writeJson(res, 401, { error: 'unknown_worker' });
    return;
  }
  if (worker.state === 'standby') {
    // Standbys never receive tasks; signal them to back off until promoted.
    writeJson(res, 409, { status: 'standby' });
    return;
  }
  // Touch lastPolledAt so the heartbeat sweep doesn't reap a healthy poll.
  opts.coordinator.registry.touchPolled(workerId, Date.now());
  const immediate = opts.coordinator.pullTaskFor(workerId);
  if (immediate) {
    log.info({ workerId, taskId: immediate.taskId, cwd: worker.cwd }, 'doorbell_dispatch');
    writeJson(res, 200, taskWirePayload(immediate));
    return;
  }
  // Empty queue: park the long-poll up to longPollTimeoutMs.
  holdLongPoll(workerId, worker.cwd, res, opts, log);
}

function holdLongPoll(
  workerId: string,
  cwd: string,
  res: ServerResponse,
  opts: DoorbellServerOptions,
  log: Logger,
): void {
  const timeoutMs = opts.longPollTimeoutMs ?? 30_000;
  let resolved = false;
  const finish = (): boolean => {
    if (resolved) return false;
    resolved = true;
    return true;
  };

  const sub = opts.coordinator.subscribePoll({
    workerId,
    onTask: (task) => {
      if (!finish()) return;
      clearTimeout(timer);
      log.info({ workerId, taskId: task.taskId, cwd }, 'doorbell_dispatch_via_longpoll');
      writeJson(res, 200, taskWirePayload(task));
    },
    onDemoted: (body) => {
      if (!finish()) return;
      clearTimeout(timer);
      log.info({ workerId, cwd }, 'doorbell_longpoll_demoted_409');
      writeJson(res, 409, body);
    },
    onRemoved: () => {
      if (!finish()) return;
      clearTimeout(timer);
      log.info({ workerId, cwd }, 'doorbell_longpoll_unknown_worker_401');
      writeJson(res, 401, { error: 'unknown_worker' });
    },
    onSuperseded: () => {
      if (!finish()) return;
      clearTimeout(timer);
      log.debug({ workerId, cwd }, 'doorbell_longpoll_superseded_204');
      res.writeHead(204);
      res.end();
    },
  });

  const timer = setTimeout(() => {
    if (!finish()) return;
    sub.cancel();
    log.debug({ workerId, cwd }, 'doorbell_longpoll_timeout_204');
    res.writeHead(204);
    res.end();
  }, timeoutMs);
  if (typeof timer.unref === 'function') timer.unref();

  // Client hangup: cancel the subscription so coordinator state doesn't
  // grow unbounded with abandoned waiters.
  res.on('close', () => {
    if (!finish()) return;
    clearTimeout(timer);
    sub.cancel();
    log.debug({ workerId, cwd }, 'doorbell_longpoll_client_hangup');
  });
}

interface ProgressBody {
  taskId: TaskId;
  workerId: WorkerId;
  /** Optional summary chunk for the IM UX (debounced upstream). */
  summary?: string;
  /** Optional ETA hint as parsed by the worker. */
  etaSeconds?: number;
  /** Optional structured progress event (stream-json derived). */
  event?: ProgressEvent;
}

function handleProgress(
  _req: IncomingMessage,
  res: ServerResponse,
  opts: DoorbellServerOptions,
  body: string,
  log: Logger,
): void {
  const parsed = parseJson<ProgressBody>(body);
  if (!parsed || !parsed.taskId || !parsed.workerId) {
    writeJson(res, 400, { error: 'missing_fields' });
    return;
  }
  // Lock check: only the owning worker (even if since demoted) can post.
  const ok = opts.coordinator.queue.updateStatus({
    taskId: parsed.taskId,
    workerId: parsed.workerId,
    status: 'running',
  });
  if (!ok) {
    writeJson(res, 403, { error: 'not_task_owner' });
    return;
  }
  // A progress post proves the worker is alive even though it's busy in a
  // task (not polling). Touch lastPolledAt so a long task isn't reaped
  // mid-run + its in-flight task re-dispatched (dogfood bug 2026-06-16).
  opts.coordinator.registry.touchPolled(parsed.workerId, Date.now());
  // Server-side ETA validation per design F14: numeric, ≤3600. The
  // worker is supposed to enforce this too, but we double-check at the
  // boundary so a malformed worker can't poison the Feishu UX.
  const eta = validateEtaSeconds(parsed.etaSeconds);
  const event = validateProgressEvent(parsed.event);
  const task = opts.coordinator.queue.get(parsed.taskId);
  if (task) {
    opts.coordinator.notifyProgress({
      task,
      ...(parsed.summary ? { summary: parsed.summary } : {}),
      ...(eta !== null ? { etaSeconds: eta } : {}),
      ...(event ? { event } : {}),
    });
  }
  log.info(
    {
      taskId: parsed.taskId,
      workerId: parsed.workerId,
      etaSeconds: eta,
      summaryLen: parsed.summary?.length,
    },
    'doorbell_progress',
  );
  writeJson(res, 200, { ok: true });
}

/**
 * GET /watch — read-only Server-Sent Events stream of WatchEvents for
 * `cc-worker watch`. HMAC-authed like every endpoint (same shared
 * secret). Sends a `snapshot` on connect, then live events. Read-only:
 * never mutates coordinator state.
 */
function handleWatch(
  req: IncomingMessage,
  res: ServerResponse,
  opts: DoorbellServerOptions,
  log: Logger,
): void {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });
  // Flush headers so the client sees the stream open immediately.
  res.write(': watch stream open\n\n');

  const unsubscribe = opts.coordinator.subscribeWatch((e) => {
    try {
      res.write(`data: ${JSON.stringify(e)}\n\n`);
    } catch {
      // write after close — cleaned up by the close handler below
    }
  });

  // Heartbeat comment keeps idle connections + proxies alive.
  const heartbeat = setInterval(() => {
    try {
      res.write(': ping\n\n');
    } catch {
      // ignore
    }
  }, 25_000);
  if (typeof heartbeat.unref === 'function') heartbeat.unref();

  req.on('close', () => {
    clearInterval(heartbeat);
    unsubscribe();
    log.info({ event: 'doorbell_audit', kind: 'watch_disconnect' }, 'doorbell_watch_close');
  });
  log.info({ event: 'doorbell_audit', kind: 'watch_connect' }, 'doorbell_watch_open');
}

function validateEtaSeconds(n: unknown): number | null {
  if (typeof n !== 'number') return null;
  if (!Number.isFinite(n) || n <= 0 || n > 3600) return null;
  return Math.round(n);
}

const PROGRESS_EVENT_KINDS = new Set(['init', 'tool', 'thinking', 'text']);
const PROGRESS_LABEL_MAX = 200;

/**
 * Validate a worker-supplied structured progress event at the trust
 * boundary: known `kind`, non-empty string `label` clipped to a sane
 * length. A malformed event is dropped (returns null) — the free-text
 * `summary` still carries liveness.
 */
function validateProgressEvent(e: unknown): ProgressEvent | null {
  if (!e || typeof e !== 'object') return null;
  const { kind, label } = e as { kind?: unknown; label?: unknown };
  if (typeof kind !== 'string' || !PROGRESS_EVENT_KINDS.has(kind)) return null;
  if (typeof label !== 'string' || label.length === 0) return null;
  return {
    kind: kind as ProgressEvent['kind'],
    label: label.length > PROGRESS_LABEL_MAX ? `${label.slice(0, PROGRESS_LABEL_MAX)}…` : label,
  };
}

interface ResultBody {
  taskId: TaskId;
  workerId: WorkerId;
  status: 'ok' | 'failed' | 'killed' | 'timeout';
  text?: string;
  errorMessage?: string;
}

function handleResult(
  _req: IncomingMessage,
  res: ServerResponse,
  opts: DoorbellServerOptions,
  body: string,
  log: Logger,
): void {
  const parsed = parseJson<ResultBody>(body);
  if (!parsed || !parsed.taskId || !parsed.workerId || !parsed.status) {
    writeJson(res, 400, { error: 'missing_fields' });
    return;
  }
  const next: TaskStatus =
    parsed.status === 'ok' ? 'done' : parsed.status === 'timeout' ? 'timeout' : 'failed';
  const ok = opts.coordinator.queue.updateStatus({
    taskId: parsed.taskId,
    workerId: parsed.workerId,
    status: next,
  });
  if (!ok) {
    writeJson(res, 403, { error: 'not_task_owner' });
    return;
  }
  const task = opts.coordinator.queue.get(parsed.taskId);
  if (task) {
    opts.coordinator.notifyTerminal({
      task,
      ...(parsed.text ? { text: parsed.text } : {}),
      ...(parsed.errorMessage ? { errorMessage: parsed.errorMessage } : {}),
    });
  }
  log.info(
    {
      taskId: parsed.taskId,
      workerId: parsed.workerId,
      reportedStatus: parsed.status,
      finalStatus: next,
    },
    'doorbell_result',
  );
  writeJson(res, 200, { ok: true });
}

// --- helpers ---------------------------------------------------------------

function stringHeader(req: IncomingMessage, name: string): string {
  const v = req.headers[name];
  if (Array.isArray(v)) return v[0] ?? '';
  return v ?? '';
}

/** Max request body the doorbell will buffer (pre-auth). 1 MB is ample for
 *  registration / progress / result JSON; anything larger is rejected with
 *  413 so an unauthenticated caller can't exhaust memory. */
const MAX_BODY_BYTES = 1024 * 1024;

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
    total += buf.length;
    if (total > MAX_BODY_BYTES) {
      // Stop consuming + free what we buffered, but DON'T destroy the socket —
      // the handler still needs to write a 413 response on it. Pausing lets
      // that response flush; the request is abandoned after.
      req.pause();
      chunks.length = 0;
      throw Object.assign(new Error('request body too large'), { code: 'BODY_TOO_LARGE' });
    }
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function parseJson<T>(body: string): T | null {
  if (!body) return null;
  try {
    return JSON.parse(body) as T;
  } catch {
    return null;
  }
}

function writeJson(
  res: ServerResponse,
  status: number,
  body: Record<string, unknown> | QueueFullError | DemotedError,
): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

function taskWirePayload(task: Task): {
  taskId: TaskId;
  prompt: string;
  cwd: string;
  deadlineMs: number;
  retryCount: number;
} {
  return {
    taskId: task.taskId,
    prompt: task.prompt,
    cwd: task.cwd,
    deadlineMs: task.deadlineMs,
    retryCount: task.retryCount,
  };
}

function closeServer(server: Server): Promise<void> {
  return new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
}

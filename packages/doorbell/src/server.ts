import { type IncomingMessage, type Server, type ServerResponse, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Logger } from '@postline/core';
import type { DoorbellCoordinator } from './coordinator.js';
import { verify } from './hmac.js';
import type {
  DemotedError,
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

  const server = createServer((req, res) => {
    handleRequest(req, res, opts, log).catch((err) => {
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
): Promise<void> {
  const method = (req.method ?? 'GET').toUpperCase();
  const path = req.url ?? '/';
  const body = await readBody(req);

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
    log.warn({ reason: auth.reason, path, method }, 'doorbell_auth_rejected');
    writeJson(res, status, { error: auth.reason });
    return;
  }

  if (method === 'POST' && path === '/mac/register') {
    return handleRegister(req, res, opts, body, log);
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
  writeJson(res, 404, { error: 'not_found' });
}

async function handleRegister(
  _req: IncomingMessage,
  res: ServerResponse,
  opts: DoorbellServerOptions,
  body: string,
  log: Logger,
): Promise<void> {
  const parsed = parseJson<WorkerRegistration>(body);
  if (!parsed) return writeJson(res, 400, { error: 'malformed_body' });
  if (!parsed.cwd || !parsed.hostname || typeof parsed.pid !== 'number') {
    return writeJson(res, 400, { error: 'missing_fields' });
  }
  const out = opts.coordinator.register({
    cwd: parsed.cwd,
    hostname: parsed.hostname,
    pid: parsed.pid,
    registeredAt: parsed.registeredAt ?? Date.now(),
  });
  log.info(
    { workerId: out.workerId, cwd: parsed.cwd, hostname: parsed.hostname, pid: parsed.pid },
    'doorbell_register',
  );
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
  // Touch lastPolledAt so the heartbeat sweep doesn’t reap a healthy poll.
  opts.coordinator.registry.touchPolled(workerId, Date.now());
  const task = opts.coordinator.pullTaskFor(workerId);
  if (!task) {
    // v1 pre-long-poll: respond immediately with 204. The long-poll
    // hold-up-to-30s arrives in the next commit.
    res.writeHead(204);
    res.end();
    return;
  }
  log.info({ workerId, taskId: task.taskId, cwd: worker.cwd }, 'doorbell_dispatch');
  writeJson(res, 200, taskWirePayload(task));
}

interface ProgressBody {
  taskId: TaskId;
  workerId: WorkerId;
  /** Optional summary chunk for the IM UX (debounced upstream). */
  summary?: string;
  /** Optional ETA hint as parsed by the worker. */
  etaSeconds?: number;
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
  log.info(
    {
      taskId: parsed.taskId,
      workerId: parsed.workerId,
      etaSeconds: parsed.etaSeconds,
      summaryLen: parsed.summary?.length,
    },
    'doorbell_progress',
  );
  writeJson(res, 200, { ok: true });
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

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
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

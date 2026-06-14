/**
 * Doorbell protocol shapes.
 *
 * Mirrors the contracts in `docs/designs/doorbell.md` v3 §4 + §5. All
 * runtime modules in this package (`hmac`, `registry`, `queue`, `server`)
 * speak in these types so behaviour stays grounded in the spec.
 */

/** 4-char base16 task id used as a UX hint; system-side key is feishuMessageId. */
export type TaskId = string;

/** A canonical worker identifier issued at registration time. */
export type WorkerId = string;

/** Worker registration payload (POST /mac/register body). */
export interface WorkerRegistration {
  /**
   * Canonicalised cwd (per design §4.4): git toplevel → realpath →
   * POSIX-normalised → preserve case. The worker is the authority on
   * what its cwd is; postline does not normalise server-side.
   */
  cwd: string;
  /** Hostname reported by the worker. Audit-only; not used for auth. */
  hostname: string;
  /**
   * Kind of agent backing this worker — `cc` (Claude Code), `codex`, etc.
   * Used by the 3-segment wake-prefix selector (`!pl@<selector>@<repo>`,
   * selector matches host OR agentKind) and the responder-attribution
   * header. Optional for back-compat: pre-redesign workers omit it, in
   * which case the selector matches on hostname only.
   */
  agentKind?: string;
  /** Process id of the worker on its host. Audit-only. */
  pid: number;
  /** Wall-clock at registration, ms since epoch. Worker-supplied. */
  registeredAt: number;
}

/** Server-side state for a single registered worker. */
export interface Worker extends WorkerRegistration {
  /** Server-issued, immutable for the worker's lifetime. */
  workerId: WorkerId;
  /** active = currently serving new dispatches; standby = waiting in FIFO. */
  state: WorkerState;
  /** Last successful poll timestamp (ms). Used by the heartbeat sweep. */
  lastPolledAt: number;
}

export type WorkerState = 'active' | 'standby';

/**
 * A task waiting for or running on a worker. Tasks are bound to a single
 * `workerId` once dispatched (§D05 task↔workerId lock); demotion does not
 * re-route in-flight tasks.
 */
export interface Task {
  taskId: TaskId;
  /** Canonical cwd this task targets. Routes to a worker for the same cwd. */
  cwd: string;
  /** Free-form prompt body for the worker to execute. */
  prompt: string;
  /** ms since epoch deadline for the worker to finish (default 5min). */
  deadlineMs: number;
  /**
   * Worker that owns this task once dispatched. `null` while the task is
   * still queued. After dispatch this is immutable for the task's
   * lifetime — even if the worker is later demoted (§D05 lock).
   */
  ownerWorkerId: WorkerId | null;
  /** Lifecycle phase. */
  status: TaskStatus;
  /** Number of redispatch attempts after a `dropped` (cap 2 per §7 row 1). */
  retryCount: number;
  /** Wall-clock at queue insertion, ms. */
  enqueuedAt: number;
  /** When the task was dispatched to a worker (200 wire response sent). */
  dispatchedAt: number | null;
  /** Optional Feishu message id used as the system-authoritative key. */
  feishuMessageId: string | null;
}

export type TaskStatus =
  | 'queued' // waiting for an active worker
  | 'dispatched' // sent to a worker, no progress yet
  | 'running' // worker has posted at least one progress chunk
  | 'done' // worker posted a `result` with status:ok
  | 'dropped' // worker died / progress stale; eligible for requeue
  | 'failed' // exhausted retries OR worker reported error
  | 'timeout'; // worker exceeded deadlineMs

/**
 * 429 body shape per design D07. `cwd` plus current queue state lets the
 * caller tell apart "queue is genuinely full" from "wrong cwd".
 */
export interface QueueFullError {
  error: 'queue_full';
  cwd: string;
  queueLen: number;
  queueMax: number;
  /** First 80 chars of the rejected prompt; helps the operator reason about which task got dropped. */
  taskHint: string;
}

/** 409 body shape per design M4 demote-on-hold-poll. */
export interface DemotedError {
  status: 'demoted';
  reason: 'another_worker_registered_for_cwd';
  newActiveWorkerId: WorkerId;
}

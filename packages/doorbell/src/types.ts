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
  /**
   * When the task first reached a terminal status (`done` / `failed` /
   * `timeout`), ms since epoch; `null` until then. Drives retention: the
   * queue prunes a terminal task once it has stayed terminal longer than
   * the retention window, so the `tasks` map doesn't grow unbounded on a
   * long-running (resident) bridge.
   */
  terminatedAt: number | null;
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

/**
 * Structured progress event derived from a worker's agent output stream
 * (e.g. Claude Code `--output-format stream-json`). Optional alongside the
 * free-text `summary`; the bridge renders it into the IM activity log and
 * the `watch` TUI. Agents that don't emit a structured stream omit this and
 * fall back to `summary` (tail of stdout).
 */
export interface ProgressEvent {
  /** Kind of activity this event represents. */
  kind: 'init' | 'tool' | 'thinking' | 'text';
  /**
   * One-line human label, already redacted/clipped by the worker.
   * e.g. `Bash: pnpm test`, `Read: matcher.ts`, `…` (thinking), or a
   * clipped assistant text snippet.
   */
  label: string;
}

/**
 * Read-only event streamed to `cc-worker watch` observers via the
 * doorbell `GET /watch` SSE endpoint (PR-OBS-2). Fan-out of what the
 * coordinator already sees — no new state store.
 */
export type WatchEvent =
  | {
      kind: 'snapshot';
      /** In-flight tasks at connect time. */
      tasks: WatchTask[];
    }
  | {
      kind: 'progress';
      taskId: TaskId;
      cwd: string;
      /** Responder identity (agentKind@repo · host) when known. */
      responder?: string;
      summary?: string;
      etaSeconds?: number;
      event?: ProgressEvent;
    }
  | {
      kind: 'terminal';
      taskId: TaskId;
      cwd: string;
      status: TaskStatus;
      errorMessage?: string;
    }
  | {
      kind: 'worker';
      /** Worker lifecycle transition. */
      action: 'registered' | 'removed';
      workerId: WorkerId;
      cwd: string;
      hostname: string;
      agentKind?: string;
    }
  | {
      /**
       * A task was queued for a cwd that has no active worker. Emitted so a
       * per-host `cc-worker-keeper` (auto-default-worker C2) can start a
       * worker for that cwd. The bridge does NOT spawn — it only signals
       * intent (RF2). The keeper decides whether to act (per-host repo
       * allowlist gate).
       */
      kind: 'wake';
      cwd: string;
      /** agentKind/host the dispatch asked for, if a 3-segment selector was used. */
      selector?: string;
      /** The waiting task's id, for logging/correlation. */
      taskId: TaskId;
    };

/** One in-flight task in a watch snapshot. */
export interface WatchTask {
  taskId: TaskId;
  cwd: string;
  status: TaskStatus;
  responder?: string;
}

/** 409 body shape per design M4 demote-on-hold-poll. */
export interface DemotedError {
  status: 'demoted';
  reason: 'another_worker_registered_for_cwd';
  newActiveWorkerId: WorkerId;
}

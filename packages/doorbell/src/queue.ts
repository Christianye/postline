import { randomBytes } from 'node:crypto';
import type { QueueFullError, Task, TaskId, WorkerId } from './types.js';

/**
 * Per-cwd FIFO task queue with a hard cap (default 10, design D07/D10).
 *
 * Semantics:
 * - One queue per cwd. The same queue holds both "no-worker yet, waiting
 *   for one to register" tasks AND "active worker is busy on prior
 *   work" tasks; D10 explicitly chose a single shared queue to avoid the
 *   '10 + 10 = 20 effective' surprise.
 * - Cap is enforced at enqueue time. Overflow returns a tagged
 *   QueueFullError; rejection does NOT consume a slot.
 * - Dispatch binds a task to a single workerId via the lock contract
 *   (§D05): once `dispatch()` is called, ownerWorkerId is set and
 *   immutable for that task's lifetime. Demotion of the owning worker
 *   does NOT re-route in-flight tasks.
 * - Result/progress reporting flows through the task's `taskId` lookup
 *   regardless of the worker's current `state` (active / standby /
 *   removed-but-still-finishing). The queue retains the task record
 *   until terminal status, so even a demoted worker can still post
 *   `done` / `failed` for tasks it owns.
 *
 * Storage: in-memory. Crash-loss is acceptable for v1 (§7.1); v2 may
 * persist to sqlite once we measure restart frequency.
 */

export interface QueueOptions {
  /** Max queued tasks per cwd before we 429. Default 10. */
  queueMax?: number;
  /** Default per-task deadline if caller doesn't override. Default 5min. */
  defaultDeadlineMs?: number;
}

export interface EnqueueParams {
  cwd: string;
  prompt: string;
  /** Optional Feishu message id; system-authoritative key (D04). */
  feishuMessageId?: string;
  /** Custom deadline override; falls back to options. */
  deadlineMs?: number;
}

export type EnqueueResult = { ok: true; task: Task } | { ok: false; error: QueueFullError };

const DEFAULT_QUEUE_MAX = 10;
const DEFAULT_DEADLINE_MS = 5 * 60_000;

export class TaskQueue {
  /** cwd → list of taskIds in FIFO order (oldest first). */
  private readonly byCwd = new Map<string, TaskId[]>();
  /** taskId → Task. Source of truth for task state. */
  private readonly tasks = new Map<TaskId, Task>();

  private readonly queueMax: number;
  private readonly defaultDeadlineMs: number;

  constructor(opts: QueueOptions = {}) {
    this.queueMax = opts.queueMax ?? DEFAULT_QUEUE_MAX;
    this.defaultDeadlineMs = opts.defaultDeadlineMs ?? DEFAULT_DEADLINE_MS;
  }

  /**
   * Insert a task at the tail of its cwd queue. Returns the task on
   * success; on overflow returns a 429-shaped error and the queue is
   * unchanged (rejection does NOT consume a slot per D07).
   */
  enqueue(params: EnqueueParams, now = Date.now()): EnqueueResult {
    const queueLen = this.byCwd.get(params.cwd)?.length ?? 0;
    if (queueLen >= this.queueMax) {
      return {
        ok: false,
        error: {
          error: 'queue_full',
          cwd: params.cwd,
          queueLen,
          queueMax: this.queueMax,
          taskHint: params.prompt.slice(0, 80),
        },
      };
    }
    const taskId = generateTaskId();
    const task: Task = {
      taskId,
      cwd: params.cwd,
      prompt: params.prompt,
      deadlineMs: now + (params.deadlineMs ?? this.defaultDeadlineMs),
      ownerWorkerId: null,
      status: 'queued',
      retryCount: 0,
      enqueuedAt: now,
      dispatchedAt: null,
      feishuMessageId: params.feishuMessageId ?? null,
    };
    this.tasks.set(taskId, task);
    const list = this.byCwd.get(params.cwd) ?? [];
    list.push(taskId);
    this.byCwd.set(params.cwd, list);
    return { ok: true, task };
  }

  /**
   * Take the next queued task for a cwd and bind it to `workerId`.
   * Returns the task or `undefined` if the queue is empty for this cwd.
   * The caller (HTTP server) is responsible for actually delivering
   * the task body to the worker (e.g. via the long-poll response).
   */
  dispatch(cwd: string, workerId: WorkerId, now = Date.now()): Task | undefined {
    const list = this.byCwd.get(cwd);
    if (!list || list.length === 0) return undefined;
    // Find the oldest task that is still in `queued` state. (Tasks may
    // be lingering in the FIFO list as `done` / `failed` until cleanup;
    // we only dispatch fresh ones.)
    let chosenIdx = -1;
    let chosenTask: Task | undefined;
    for (let i = 0; i < list.length; i++) {
      const tid = list[i];
      if (!tid) continue;
      const t = this.tasks.get(tid);
      if (t && t.status === 'queued') {
        chosenIdx = i;
        chosenTask = t;
        break;
      }
    }
    if (!chosenTask || chosenIdx < 0) return undefined;
    list.splice(chosenIdx, 1);
    if (list.length === 0) this.byCwd.delete(cwd);
    chosenTask.ownerWorkerId = workerId;
    chosenTask.status = 'dispatched';
    chosenTask.dispatchedAt = now;
    return chosenTask;
  }

  /** Get a task by id. */
  get(taskId: TaskId): Task | undefined {
    return this.tasks.get(taskId);
  }

  /** Lookup by Feishu message id (the system-authoritative key per D04). */
  getByFeishuMessageId(messageId: string): Task | undefined {
    for (const t of this.tasks.values()) {
      if (t.feishuMessageId === messageId) return t;
    }
    return undefined;
  }

  /**
   * Mark a task's status. Called by the server when worker posts
   * progress / result. Validates the worker owns the task (lock from
   * §M3); returns false if the caller's workerId doesn't match.
   */
  updateStatus(params: {
    taskId: TaskId;
    workerId: WorkerId;
    status: Task['status'];
  }): boolean {
    const t = this.tasks.get(params.taskId);
    if (!t) return false;
    if (t.ownerWorkerId !== params.workerId) return false;
    t.status = params.status;
    return true;
  }

  /**
   * Drop a worker's claim on its in-flight tasks (used when sweep
   * removes them). Tasks are reset to `queued` so they can be picked
   * up by a future worker, retryCount incremented. Returns the count
   * of tasks reverted.
   */
  releaseWorker(workerId: WorkerId): number {
    let count = 0;
    for (const t of this.tasks.values()) {
      if (t.ownerWorkerId === workerId && (t.status === 'dispatched' || t.status === 'running')) {
        t.ownerWorkerId = null;
        t.status = 'queued';
        t.retryCount += 1;
        t.dispatchedAt = null;
        // Re-add to head of cwd queue so it's the next dispatched.
        const list = this.byCwd.get(t.cwd) ?? [];
        list.unshift(t.taskId);
        this.byCwd.set(t.cwd, list);
        count += 1;
      }
    }
    return count;
  }

  /**
   * Read-only count of queued tasks for a cwd (waiting + active-worker
   * backlog). Used by the server to compute the 429 body's queueLen.
   */
  queueLen(cwd: string): number {
    return this.byCwd.get(cwd)?.length ?? 0;
  }

  /** Total active queues, mostly for tests + the workers query. */
  cwds(): readonly string[] {
    return [...this.byCwd.keys()];
  }
}

/**
 * 4-character base16 task id. Per design D04 this is a human-display
 * hint only; the system-authoritative key for status lookups is the
 * Feishu message id. 65k space is fine because we don't persist across
 * restart (§7.1) — collisions only matter within a process lifetime,
 * and even there a 4-char clash is ~1/65k chance per new task.
 */
function generateTaskId(): TaskId {
  return randomBytes(2).toString('hex');
}

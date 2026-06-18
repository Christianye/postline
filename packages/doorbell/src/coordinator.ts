import type { Logger } from '@postline/core';
import { type EnqueueParams, TaskQueue } from './queue.js';
import { WorkerRegistry } from './registry.js';
import type {
  DemotedError,
  ProgressEvent,
  Task,
  WatchEvent,
  WatchTask,
  Worker,
  WorkerId,
  WorkerRegistration,
} from './types.js';

/**
 * Whether `worker` is allowed to take `task`. A task with a non-null
 * `selector` (from `!pl@<selector>@<repo>`) may only go to a worker whose
 * agentKind OR hostname matches it — mirrors `registry.activeForCwd`'s match
 * rule. A task with no selector goes to any worker (legacy behaviour). This
 * is what stops a polling cc worker from grabbing a `@codex`-targeted task on
 * the same cwd (the dispatch path is otherwise selector-blind).
 */
function taskMatchesWorker(task: Task, worker: Worker): boolean {
  if (!task.selector) return true;
  return worker.agentKind === task.selector || worker.hostname === task.selector;
}

/**
 * Coordinator — wires the worker registry to the task queue.
 *
 * The two pieces are intentionally decoupled at the data-structure
 * level (registry knows about workers, queue knows about tasks; no
 * direct reference). This file is the only place that knows the
 * cross-cutting contracts:
 *
 * - When a worker is removed (heartbeat sweep, explicit unregister,
 *   registration loss), its in-flight tasks revert to `queued` via
 *   `queue.releaseWorker(workerId)` — see design §M3 / §7 row 1.
 * - When a worker is demoted to standby because a newer worker took
 *   the slot for the same cwd, the demoted worker's tasks STAY bound
 *   to it (lock contract from §M3): the registry's onDemoted hook is
 *   recorded as a "pending demote" the HTTP server can use to close
 *   that worker's hold-poll with 409 (§M4 wired in the server commit).
 * - When a worker is promoted (standby → active), the queue is
 *   immediately polled for tasks queued for that cwd; the coordinator
 *   exposes a `drainOnPromote` callback the HTTP layer subscribes to.
 *
 * Threading: single-event-loop, like the registry and queue.
 *
 * The coordinator is also where the heartbeat sweep timer is owned;
 * lifting it here keeps `runFeishu` from having to manage three timers
 * (poller, sweep, ...) for related concerns.
 */

export interface CoordinatorOptions {
  /**
   * How often to run the heartbeat sweep (ms). Default 60_000 (60s),
   * matching design §6 + §7.
   */
  sweepIntervalMs?: number;
  /**
   * Worker is considered stale if its lastPolledAt is older than
   * (now - thresholdMs). Default 60_000.
   */
  staleThresholdMs?: number;
  /** Per-task default deadline for the queue. Default 5min. */
  defaultTaskDeadlineMs?: number;
  /** Queue cap per cwd. Default 10. */
  queueMax?: number;
  /**
   * How long a terminal task is retained in the queue before the sweep
   * prunes it (ms). Keeps late duplicate result posts + the terminal hook
   * working while bounding the `tasks` map on a long-running bridge.
   * Default 60_000 (60s).
   */
  terminalRetentionMs?: number;
  /**
   * Hook fired when a worker is demoted while it likely holds a
   * long-poll connection. The HTTP server uses this to close that
   * connection with HTTP 409 + body. Best-effort: thrown errors are
   * caught and logged.
   */
  onWorkerDemotedWithPoll?: (params: {
    demotedWorkerId: WorkerId;
    body: DemotedError;
  }) => void;
  /**
   * Hook fired when a worker is promoted to active. The HTTP server
   * uses this to wake any pending dispatch attempts so the queued
   * tasks for that cwd start flowing immediately.
   */
  onWorkerPromoted?: (worker: Worker) => void;
  /**
   * Hook fired when a task's progress is reported by its owning worker.
   * cmd-feishu subscribes to this to edit the seed Feishu message in
   * place (PR-DB-4 progress UX). `etaSeconds` is the worker-supplied
   * ETA (validated to ≤3600); `summary` is a debounced stdout snippet.
   */
  onTaskProgress?: (params: {
    task: Task;
    summary?: string;
    etaSeconds?: number;
    event?: ProgressEvent;
  }) => void;
  /**
   * Hook fired when a task reaches a terminal status (`done` /
   * `failed` / `timeout` / `killed`). cmd-feishu uses this to edit
   * the seed Feishu message into its final form.
   */
  onTaskTerminal?: (params: {
    task: Task;
    text?: string;
    errorMessage?: string;
  }) => void;
  log: Logger;
}

/**
 * One subscriber per worker-active long-poll waiter. The server creates
 * these inside its `/mac/poll` handler and `cancel()`s them on hangup
 * or when its own timer wins. Coordinator-side state never holds more
 * than one waiter per workerId — duplicate subscribe replaces the prior.
 */
export interface PollWaiter {
  /** Worker that is waiting. */
  workerId: WorkerId;
  /** Called when a task is dispatched to this worker. */
  onTask: (task: Task) => void;
  /** Called when this worker has been demoted while waiting. */
  onDemoted: (body: DemotedError) => void;
  /** Called when this worker has been removed (sweep / unregister). */
  onRemoved: () => void;
}

export class DoorbellCoordinator {
  readonly registry: WorkerRegistry;
  readonly queue: TaskQueue;

  private readonly log: Logger;
  private readonly sweepIntervalMs: number;
  private readonly staleThresholdMs: number;
  private readonly terminalRetentionMs: number;
  private readonly hookOnDemoted?: (params: {
    demotedWorkerId: WorkerId;
    body: DemotedError;
  }) => void;
  private readonly hookOnPromoted?: (worker: Worker) => void;
  private readonly hookOnTaskProgress?: (params: {
    task: Task;
    summary?: string;
    etaSeconds?: number;
    event?: ProgressEvent;
  }) => void;
  private readonly hookOnTaskTerminal?: (params: {
    task: Task;
    text?: string;
    errorMessage?: string;
  }) => void;

  private sweepTimer: NodeJS.Timeout | null = null;

  /** workerId → active poll waiter (at most one per worker). */
  private readonly waiters = new Map<WorkerId, PollWaiter>();

  /** Read-only watch subscribers (cc-worker watch via GET /watch). */
  private readonly watchers = new Set<(e: WatchEvent) => void>();

  constructor(opts: CoordinatorOptions) {
    this.log = opts.log.child({ component: 'doorbell_coordinator' });
    this.sweepIntervalMs = opts.sweepIntervalMs ?? 60_000;
    this.staleThresholdMs = opts.staleThresholdMs ?? 60_000;
    this.terminalRetentionMs = opts.terminalRetentionMs ?? 60_000;
    if (opts.onWorkerDemotedWithPoll) this.hookOnDemoted = opts.onWorkerDemotedWithPoll;
    if (opts.onWorkerPromoted) this.hookOnPromoted = opts.onWorkerPromoted;
    if (opts.onTaskProgress) this.hookOnTaskProgress = opts.onTaskProgress;
    if (opts.onTaskTerminal) this.hookOnTaskTerminal = opts.onTaskTerminal;

    this.queue = new TaskQueue({
      ...(opts.queueMax !== undefined ? { queueMax: opts.queueMax } : {}),
      ...(opts.defaultTaskDeadlineMs !== undefined
        ? { defaultDeadlineMs: opts.defaultTaskDeadlineMs }
        : {}),
    });
    this.registry = new WorkerRegistry({
      onDemoted: ({ demoted, newActive }) => this.handleDemoted(demoted, newActive),
      onRemoved: (worker) => this.handleRemoved(worker),
      onPromoted: (worker) => this.handlePromoted(worker),
    });
  }

  /** Start the periodic heartbeat sweep timer. Idempotent. */
  start(): void {
    if (this.sweepTimer) return;
    this.sweepTimer = setInterval(() => {
      try {
        const now = Date.now();
        // Exempt workers running an in-flight task (long tasks don't poll).
        const swept = this.registry.sweepStale(
          now,
          this.staleThresholdMs,
          this.queue.busyWorkerIds(),
        );
        if (swept.length > 0) {
          this.log.info(
            { count: swept.length, ids: swept.map((w) => w.workerId) },
            'doorbell_heartbeat_sweep',
          );
        }
        // Prune long-terminal tasks so the queue's task map stays bounded
        // on a long-running (resident) bridge.
        const pruned = this.queue.sweepTerminal(now, this.terminalRetentionMs);
        if (pruned > 0) {
          this.log.info({ count: pruned }, 'doorbell_terminal_task_sweep');
        }
      } catch (err) {
        this.log.warn({ err: (err as Error).message }, 'doorbell_heartbeat_sweep_error');
      }
    }, this.sweepIntervalMs);
    if (typeof this.sweepTimer.unref === 'function') this.sweepTimer.unref();
    this.log.info(
      { sweepIntervalMs: this.sweepIntervalMs, staleThresholdMs: this.staleThresholdMs },
      'doorbell_coordinator_started',
    );
  }

  /** Stop the timer; safe to call multiple times. */
  stop(): void {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
      this.log.info({}, 'doorbell_coordinator_stopped');
    }
  }

  /** Convenience: register + return both id and state. */
  register(reg: WorkerRegistration): ReturnType<WorkerRegistry['register']> {
    const out = this.registry.register(reg);
    this.emitWatch({
      kind: 'worker',
      action: 'registered',
      workerId: out.workerId,
      cwd: reg.cwd,
      hostname: reg.hostname,
      ...(reg.agentKind ? { agentKind: reg.agentKind } : {}),
    });
    return out;
  }

  /**
   * Try to pull a task for the given worker. Returns the dispatched
   * task (`status: 'dispatched'`) or `undefined` when the cwd queue
   * has no fresh task. Only the active worker for a cwd should ever
   * be calling this; the HTTP layer enforces that gate.
   */
  pullTaskFor(workerId: WorkerId, now = Date.now()): Task | undefined {
    const worker = this.registry.get(workerId);
    if (!worker) return undefined;
    return this.queue.dispatch(worker.cwd, workerId, now, (task) =>
      taskMatchesWorker(task, worker),
    );
  }

  /**
   * Enqueue a task and, if its cwd has an active worker waiting on a
   * long-poll, dispatch it to them immediately. Returns the same shape
   * as `queue.enqueue`. The HTTP layer's dispatch path is supposed to
   * call this rather than `queue.enqueue` directly; otherwise queued
   * tasks won't wake the long-poll until the timer fires.
   */
  enqueueAndMaybeDispatch(
    params: EnqueueParams & { selector?: string },
    now = Date.now(),
  ): ReturnType<TaskQueue['enqueue']> {
    const r = this.queue.enqueue(params, now);
    if (!r.ok) return r;
    // Selector (from `!pl@<selector>@<repo>`) picks the matching active
    // worker (agentKind or host); without one, the cwd's default active
    // worker — identical to pre-selector behaviour.
    const active = this.registry.activeForCwd(params.cwd, params.selector);
    if (active) {
      const waiter = this.waiters.get(active.workerId);
      if (waiter) {
        const dispatched = this.queue.dispatch(active.cwd, active.workerId, now, (task) =>
          taskMatchesWorker(task, active),
        );
        if (dispatched) {
          this.waiters.delete(active.workerId);
          try {
            waiter.onTask(dispatched);
          } catch (err) {
            this.log.warn(
              { err: (err as Error).message, workerId: active.workerId },
              'doorbell_waiter_onTask_error',
            );
          }
        }
      }
    } else {
      // No active worker for this cwd: the task is queued + held (C1). Emit
      // a wake intent so a per-host keeper (C2) can start a worker. Pure
      // signal — the bridge never spawns (RF2).
      this.emitWatch({
        kind: 'wake',
        cwd: params.cwd,
        ...(params.selector ? { selector: params.selector } : {}),
        taskId: r.task.taskId,
      });
    }
    return r;
  }

  /**
   * Notify subscribers of a progress event for a task. Called from the
   * HTTP layer's /mac/progress handler after the lock check passes.
   */
  notifyProgress(params: {
    task: Task;
    summary?: string;
    etaSeconds?: number;
    event?: ProgressEvent;
  }): void {
    const responder = this.responderFor(params.task);
    this.emitWatch({
      kind: 'progress',
      taskId: params.task.taskId,
      cwd: params.task.cwd,
      ...(responder ? { responder } : {}),
      ...(params.summary ? { summary: params.summary } : {}),
      ...(params.etaSeconds !== undefined ? { etaSeconds: params.etaSeconds } : {}),
      ...(params.event ? { event: params.event } : {}),
    });
    if (!this.hookOnTaskProgress) return;
    try {
      this.hookOnTaskProgress(params);
    } catch (err) {
      this.log.warn(
        { err: (err as Error).message, taskId: params.task.taskId },
        'doorbell_progress_hook_error',
      );
    }
  }

  /**
   * Notify subscribers of a terminal event (done / failed / timeout /
   * killed). Called from /mac/result handler after lock check.
   */
  notifyTerminal(params: { task: Task; text?: string; errorMessage?: string }): void {
    this.emitWatch({
      kind: 'terminal',
      taskId: params.task.taskId,
      cwd: params.task.cwd,
      status: params.task.status,
      ...(params.errorMessage ? { errorMessage: params.errorMessage } : {}),
    });
    if (!this.hookOnTaskTerminal) return;
    try {
      this.hookOnTaskTerminal(params);
    } catch (err) {
      this.log.warn(
        { err: (err as Error).message, taskId: params.task.taskId },
        'doorbell_terminal_hook_error',
      );
    }
  }

  /**
   * Park a worker's long-poll. The HTTP layer calls this when a poll
   * comes in and the queue is empty; the coordinator stores the waiter
   * so it can wake it up on enqueue / demotion / removal. Replaces any
   * prior waiter for the same workerId (only one outstanding poll per
   * worker is meaningful — a fresh request supersedes the old one).
   */
  subscribePoll(waiter: PollWaiter): { cancel: () => void } {
    const existing = this.waiters.get(waiter.workerId);
    if (existing) {
      // Replace silently; the prior poll is being abandoned by the same
      // worker, which the HTTP layer should treat as 'reconnect'.
      this.waiters.delete(waiter.workerId);
    }
    this.waiters.set(waiter.workerId, waiter);
    return {
      cancel: () => {
        const cur = this.waiters.get(waiter.workerId);
        if (cur === waiter) this.waiters.delete(waiter.workerId);
      },
    };
  }

  // --- watch (read-only observers) --------------------------------------------

  /**
   * Subscribe to the read-only watch event stream. Immediately invokes
   * `cb` with a `snapshot` of in-flight tasks, then with each live event.
   * Returns an unsubscribe fn. Used by the doorbell `GET /watch` SSE.
   */
  subscribeWatch(cb: (e: WatchEvent) => void): () => void {
    this.watchers.add(cb);
    try {
      cb({ kind: 'snapshot', tasks: this.snapshotInFlight() });
    } catch (err) {
      this.log.warn({ err: (err as Error).message }, 'doorbell_watch_snapshot_error');
    }
    return () => {
      this.watchers.delete(cb);
    };
  }

  /** In-flight (queued / dispatched / running) tasks, for watch snapshots. */
  snapshotInFlight(): WatchTask[] {
    const out: WatchTask[] = [];
    for (const task of this.queue.all()) {
      if (task.status === 'queued' || task.status === 'dispatched' || task.status === 'running') {
        const responder = this.responderFor(task);
        out.push({
          taskId: task.taskId,
          cwd: task.cwd,
          status: task.status,
          ...(responder ? { responder } : {}),
        });
      }
    }
    return out;
  }

  private emitWatch(e: WatchEvent): void {
    for (const cb of this.watchers) {
      try {
        cb(e);
      } catch (err) {
        this.log.warn({ err: (err as Error).message }, 'doorbell_watch_emit_error');
      }
    }
  }

  /** `agentKind@repo · host` for a task's owning worker, when known. */
  private responderFor(task: Task): string | undefined {
    if (!task.ownerWorkerId) return undefined;
    const w = this.registry.get(task.ownerWorkerId);
    if (!w) return undefined;
    const repo = task.cwd.split('/').filter(Boolean).pop() ?? task.cwd;
    return `${w.agentKind ?? 'cc'}@${repo} · ${w.hostname}`;
  }

  // --- registry hook handlers -------------------------------------------------

  private handleDemoted(demoted: Worker, newActive: Worker): void {
    const body: DemotedError = {
      status: 'demoted',
      reason: 'another_worker_registered_for_cwd',
      newActiveWorkerId: newActive.workerId,
    };
    // Wake any in-flight long-poll the demoted worker had with a 409.
    const waiter = this.waiters.get(demoted.workerId);
    if (waiter) {
      this.waiters.delete(demoted.workerId);
      try {
        waiter.onDemoted(body);
      } catch (err) {
        this.log.warn(
          { err: (err as Error).message, demoted: demoted.workerId },
          'doorbell_waiter_onDemoted_error',
        );
      }
    }
    // Tasks already dispatched stay bound to the demoted worker (M3
    // lock); we just notify the HTTP layer so it can close any open
    // long-poll the demoted worker had (the waiter path above), and
    // also surface to the broader hook for non-poll observers.
    try {
      this.hookOnDemoted?.({ demotedWorkerId: demoted.workerId, body });
    } catch (err) {
      this.log.warn(
        { err: (err as Error).message, demoted: demoted.workerId },
        'doorbell_demote_hook_error',
      );
    }
  }

  private handleRemoved(worker: Worker): void {
    this.emitWatch({
      kind: 'worker',
      action: 'removed',
      workerId: worker.workerId,
      cwd: worker.cwd,
      hostname: worker.hostname,
      ...(worker.agentKind ? { agentKind: worker.agentKind } : {}),
    });
    // Wake any in-flight long-poll for this worker with onRemoved so
    // the HTTP server can return 401 unknown_worker.
    const waiter = this.waiters.get(worker.workerId);
    if (waiter) {
      this.waiters.delete(worker.workerId);
      try {
        waiter.onRemoved();
      } catch (err) {
        this.log.warn(
          { err: (err as Error).message, worker: worker.workerId },
          'doorbell_waiter_onRemoved_error',
        );
      }
    }
    // Hard removal: revert in-flight tasks. Tasks under the retry cap go
    // back to the head of the cwd queue (retryCount++); tasks that have
    // exhausted the cap are failed (not requeued) so a poison task can't
    // head-of-line the queue forever.
    const { requeued, failed } = this.queue.releaseWorker(worker.workerId);
    if (requeued.length > 0) {
      this.log.info(
        { worker: worker.workerId, cwd: worker.cwd, reverted: requeued.length },
        'doorbell_worker_removed_tasks_reverted',
      );
    }
    for (const task of failed) {
      this.log.warn(
        {
          worker: worker.workerId,
          cwd: worker.cwd,
          taskId: task.taskId,
          retryCount: task.retryCount,
        },
        'doorbell_task_failed_retry_exhausted',
      );
      this.notifyTerminal({ task, errorMessage: 'retries exhausted (worker kept dropping it)' });
    }
  }

  private handlePromoted(worker: Worker): void {
    // If the promoted worker had a long-poll parked (e.g. it was just
    // standby and is now active because the prior active died), check
    // for queued work and dispatch it. This is the "drain on promote"
    // path the design references in §D05.
    const waiter = this.waiters.get(worker.workerId);
    if (waiter) {
      const dispatched = this.queue.dispatch(worker.cwd, worker.workerId, Date.now(), (task) =>
        taskMatchesWorker(task, worker),
      );
      if (dispatched) {
        this.waiters.delete(worker.workerId);
        try {
          waiter.onTask(dispatched);
        } catch (err) {
          this.log.warn(
            { err: (err as Error).message, worker: worker.workerId },
            'doorbell_waiter_onTask_error',
          );
        }
      }
    }
    try {
      this.hookOnPromoted?.(worker);
    } catch (err) {
      this.log.warn(
        { err: (err as Error).message, worker: worker.workerId },
        'doorbell_promote_hook_error',
      );
    }
  }
}

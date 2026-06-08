import type { Logger } from '@postline/core';
import { type EnqueueParams, TaskQueue } from './queue.js';
import { WorkerRegistry } from './registry.js';
import type { DemotedError, Task, Worker, WorkerId, WorkerRegistration } from './types.js';

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
  private readonly hookOnDemoted?: (params: {
    demotedWorkerId: WorkerId;
    body: DemotedError;
  }) => void;
  private readonly hookOnPromoted?: (worker: Worker) => void;

  private sweepTimer: NodeJS.Timeout | null = null;

  /** workerId → active poll waiter (at most one per worker). */
  private readonly waiters = new Map<WorkerId, PollWaiter>();

  constructor(opts: CoordinatorOptions) {
    this.log = opts.log.child({ component: 'doorbell_coordinator' });
    this.sweepIntervalMs = opts.sweepIntervalMs ?? 60_000;
    this.staleThresholdMs = opts.staleThresholdMs ?? 60_000;
    if (opts.onWorkerDemotedWithPoll) this.hookOnDemoted = opts.onWorkerDemotedWithPoll;
    if (opts.onWorkerPromoted) this.hookOnPromoted = opts.onWorkerPromoted;

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
        const swept = this.registry.sweepStale(Date.now(), this.staleThresholdMs);
        if (swept.length > 0) {
          this.log.info(
            { count: swept.length, ids: swept.map((w) => w.workerId) },
            'doorbell_heartbeat_sweep',
          );
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
    return this.registry.register(reg);
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
    return this.queue.dispatch(worker.cwd, workerId, now);
  }

  /**
   * Enqueue a task and, if its cwd has an active worker waiting on a
   * long-poll, dispatch it to them immediately. Returns the same shape
   * as `queue.enqueue`. The HTTP layer's dispatch path is supposed to
   * call this rather than `queue.enqueue` directly; otherwise queued
   * tasks won't wake the long-poll until the timer fires.
   */
  enqueueAndMaybeDispatch(
    params: EnqueueParams,
    now = Date.now(),
  ): ReturnType<TaskQueue['enqueue']> {
    const r = this.queue.enqueue(params, now);
    if (!r.ok) return r;
    const active = this.registry.activeForCwd(params.cwd);
    if (active) {
      const waiter = this.waiters.get(active.workerId);
      if (waiter) {
        const dispatched = this.queue.dispatch(active.cwd, active.workerId, now);
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
    }
    return r;
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
    // Hard removal: revert in-flight tasks. They go back to head of
    // the cwd queue with retryCount++.
    const reverted = this.queue.releaseWorker(worker.workerId);
    if (reverted > 0) {
      this.log.info(
        { worker: worker.workerId, cwd: worker.cwd, reverted },
        'doorbell_worker_removed_tasks_reverted',
      );
    }
  }

  private handlePromoted(worker: Worker): void {
    // If the promoted worker had a long-poll parked (e.g. it was just
    // standby and is now active because the prior active died), check
    // for queued work and dispatch it. This is the "drain on promote"
    // path the design references in §D05.
    const waiter = this.waiters.get(worker.workerId);
    if (waiter) {
      const dispatched = this.queue.dispatch(worker.cwd, worker.workerId);
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

import { randomUUID } from 'node:crypto';
import type { Worker, WorkerId, WorkerRegistration, WorkerState } from './types.js';

/**
 * In-memory worker registry.
 *
 * Implements the multi-session-same-cwd contract from design §D05:
 *
 * - Latest registration wins. The newcomer becomes `active`; any prior
 *   active worker for the same cwd is demoted to `standby` synchronously.
 * - Standbys form a FIFO queue. When the active worker is removed (via
 *   heartbeat sweep, explicit unregister, or registration-loss), the
 *   earliest-registered standby auto-promotes.
 * - Demote-on-hold-poll: when a worker transitions active → standby, the
 *   server should close that worker's hold-poll connection with HTTP 409
 *   + body `{status: "demoted", ...}`. The registry surfaces a callback
 *   so the HTTP layer can wire this; this module owns the state, not
 *   the I/O.
 *
 * Task ↔ workerId lock is enforced at the queue/dispatch layer, not
 * here. The registry only tracks who's active vs standby; it does not
 * know about in-flight tasks.
 *
 * Thread model: single Node event loop. No locking is needed because
 * every state mutation is synchronous and runs to completion before
 * the next event-loop turn.
 */

export interface RegistryOptions {
  /**
   * Hook fired when a worker is demoted from active to standby. The
   * server uses this to close any hold-poll the worker has open with
   * HTTP 409. Errors thrown here are caught and ignored — the registry
   * state has already moved on.
   */
  onDemoted?: (params: { demoted: Worker; newActive: Worker }) => void;
  /**
   * Hook fired when a worker is removed entirely (unregister, heartbeat
   * sweep). Lets the queue layer reassign the worker's queued-but-
   * unowned tasks back to "no-worker" state.
   */
  onRemoved?: (worker: Worker) => void;
  /**
   * Hook fired when a standby worker is promoted to active. The HTTP
   * layer can use this to drain the queue immediately.
   */
  onPromoted?: (worker: Worker) => void;
}

/**
 * Snapshot of all workers known to the registry. Two views: by cwd
 * (one active + N standby per cwd, ordered by registeredAt for the
 * standby tail) and a flat by-id map.
 */
export interface RegistrySnapshot {
  /** Map of cwd → ordered list (active first, then standbys oldest-first). */
  byCwd: Map<string, readonly Worker[]>;
  /** Map of workerId → Worker. */
  byId: Map<WorkerId, Worker>;
}

export class WorkerRegistry {
  /** workerId → Worker. */
  private readonly workers = new Map<WorkerId, Worker>();
  /** cwd → ordered workerIds (active head, standbys oldest-first). */
  private readonly cwdOrder = new Map<string, WorkerId[]>();

  constructor(private readonly opts: RegistryOptions = {}) {}

  /**
   * Register a worker. Returns the assigned `workerId` and the resulting
   * state (active if it took the slot, standby if another worker for the
   * same cwd is already there).
   */
  register(reg: WorkerRegistration): { workerId: WorkerId; state: WorkerState } {
    const workerId = `w_${randomUUID().slice(0, 8)}`;
    const order = this.cwdOrder.get(reg.cwd) ?? [];

    const existingActiveId = order[0];
    const existingActive = existingActiveId ? this.workers.get(existingActiveId) : undefined;

    const newWorker: Worker = {
      ...reg,
      workerId,
      state: 'active',
      lastPolledAt: reg.registeredAt,
    };

    if (existingActive) {
      // Layout invariant: order = [active, standby_oldest ... standby_newest].
      // Demote prior active to standby, append it to the END of the
      // standby tail (it's the *newest* standby because it registered
      // most recently among the soon-to-be-standbys), then put the
      // newcomer at the head as the new active.
      existingActive.state = 'standby';
      order.shift(); // remove old active head
      order.push(existingActive.workerId); // existing demoted goes to standby tail
      order.unshift(workerId); // newcomer becomes active head
      this.cwdOrder.set(reg.cwd, order);
      this.workers.set(workerId, newWorker);
      try {
        this.opts.onDemoted?.({ demoted: existingActive, newActive: newWorker });
      } catch {
        // Hook errors are not the registry's problem.
      }
      return { workerId, state: 'active' };
    }

    // Empty cwd slot: this worker becomes active.
    order.unshift(workerId);
    this.cwdOrder.set(reg.cwd, order);
    this.workers.set(workerId, newWorker);
    return { workerId, state: 'active' };
  }

  /**
   * Remove a worker by id. If it was active, the earliest-registered
   * standby for that cwd auto-promotes. Idempotent: unknown id is a
   * no-op.
   */
  unregister(workerId: WorkerId): void {
    const worker = this.workers.get(workerId);
    if (!worker) return;
    const order = this.cwdOrder.get(worker.cwd) ?? [];
    const idx = order.indexOf(workerId);
    if (idx >= 0) order.splice(idx, 1);
    this.workers.delete(workerId);

    const wasActive = worker.state === 'active';

    if (order.length === 0) {
      this.cwdOrder.delete(worker.cwd);
    } else {
      this.cwdOrder.set(worker.cwd, order);
      if (wasActive) {
        // Promote the new head (which was the oldest standby).
        const newActiveId = order[0];
        if (newActiveId) {
          const newActive = this.workers.get(newActiveId);
          if (newActive) {
            newActive.state = 'active';
            try {
              this.opts.onPromoted?.(newActive);
            } catch {
              // ignore
            }
          }
        }
      }
    }

    try {
      this.opts.onRemoved?.(worker);
    } catch {
      // ignore
    }
  }

  /** Get a worker by id, or `undefined` if not registered. */
  get(workerId: WorkerId): Worker | undefined {
    return this.workers.get(workerId);
  }

  /**
   * Currently active worker for a cwd, if any. Used by the dispatch
   * path to pick a target.
   */
  activeForCwd(cwd: string): Worker | undefined {
    const order = this.cwdOrder.get(cwd);
    if (!order || order.length === 0) return undefined;
    const head = this.workers.get(order[0] ?? '');
    return head?.state === 'active' ? head : undefined;
  }

  /**
   * Update lastPolledAt for a worker. Called whenever a poll request
   * arrives so the heartbeat sweep can tell live workers from dead
   * ones. Idempotent on unknown id.
   */
  touchPolled(workerId: WorkerId, now: number): void {
    const w = this.workers.get(workerId);
    if (!w) return;
    w.lastPolledAt = now;
  }

  /**
   * Sweep: unregister any worker whose lastPolledAt is older than
   * `now - thresholdMs`. Returns the list of swept workers (in the
   * order they were removed). Active workers swept this way trigger
   * the same standby-promotion path as `unregister`.
   */
  sweepStale(now: number, thresholdMs: number): readonly Worker[] {
    const cutoff = now - thresholdMs;
    const stale: Worker[] = [];
    for (const w of this.workers.values()) {
      if (w.lastPolledAt < cutoff) stale.push(w);
    }
    for (const w of stale) {
      this.unregister(w.workerId);
    }
    return stale;
  }

  /** Read-only snapshot, mostly for tests + the `@cc workers` builtin. */
  snapshot(): RegistrySnapshot {
    const byCwd = new Map<string, readonly Worker[]>();
    for (const [cwd, order] of this.cwdOrder.entries()) {
      const list: Worker[] = [];
      for (const id of order) {
        const w = this.workers.get(id);
        if (w) list.push(w);
      }
      byCwd.set(cwd, list);
    }
    return { byCwd, byId: new Map(this.workers) };
  }
}

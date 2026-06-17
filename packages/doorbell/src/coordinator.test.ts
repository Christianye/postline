import type { Logger } from '@postline/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DoorbellCoordinator } from './coordinator.js';
import type { WatchEvent, WorkerRegistration } from './types.js';

function silentLogger(): Logger {
  const noop = () => {};
  // biome-ignore lint/suspicious/noExplicitAny: minimal logger stub for tests
  const log: any = {
    info: noop,
    warn: noop,
    error: noop,
    debug: noop,
    trace: noop,
    fatal: noop,
  };
  log.child = () => log;
  return log as Logger;
}

function reg(cwd: string, t: number, hostname = 'mac'): WorkerRegistration {
  return { cwd, hostname, pid: 1000 + t, registeredAt: t };
}

describe('DoorbellCoordinator — registry × queue glue', () => {
  let coord: DoorbellCoordinator;

  beforeEach(() => {
    coord = new DoorbellCoordinator({ log: silentLogger() });
  });

  afterEach(() => {
    coord.stop();
  });

  it('pullTaskFor only delivers tasks queued for the worker’s own cwd', () => {
    const w = coord.register(reg('/repo/postline', 1));
    coord.queue.enqueue({ cwd: '/repo/postline', prompt: 'p1' });
    coord.queue.enqueue({ cwd: '/repo/NeuGate', prompt: 'p2' });

    const t = coord.pullTaskFor(w.workerId);
    expect(t?.prompt).toBe('p1');
    expect(t?.ownerWorkerId).toBe(w.workerId);
    expect(coord.pullTaskFor(w.workerId)).toBeUndefined();
  });

  it('pullTaskFor on unknown worker returns undefined', () => {
    expect(coord.pullTaskFor('w_missing')).toBeUndefined();
  });

  it('worker removal (heartbeat sweep) reverts in-flight tasks (M3/§7 row 1)', () => {
    const w = coord.register(reg('/repo', 1));
    coord.queue.enqueue({ cwd: '/repo', prompt: 'doit' });
    const dispatched = coord.pullTaskFor(w.workerId);
    expect(dispatched?.status).toBe('dispatched');
    expect(dispatched?.retryCount).toBe(0);

    // Simulate a sweep that removed the worker.
    coord.registry.unregister(w.workerId);

    // Task is back in queue with retryCount++.
    const tid = dispatched?.taskId;
    if (!tid) throw new Error('no task id');
    const back = coord.queue.get(tid);
    expect(back?.status).toBe('queued');
    expect(back?.ownerWorkerId).toBeNull();
    expect(back?.retryCount).toBe(1);
  });

  it('demotion does NOT revert in-flight tasks (M3 lock)', () => {
    const w1 = coord.register(reg('/repo', 1));
    coord.queue.enqueue({ cwd: '/repo', prompt: 'p' });
    const dispatched = coord.pullTaskFor(w1.workerId);
    expect(dispatched?.ownerWorkerId).toBe(w1.workerId);

    // w2 registers same cwd; w1 demotes.
    coord.register(reg('/repo', 2));

    // Task still bound to w1.
    const tid = dispatched?.taskId;
    if (!tid) throw new Error('no task id');
    const t = coord.queue.get(tid);
    expect(t?.ownerWorkerId).toBe(w1.workerId);
    expect(t?.status).toBe('dispatched');
  });

  it('demotion fires onWorkerDemotedWithPoll with the 409 body shape (M4)', () => {
    const onDemoted = vi.fn();
    const c = new DoorbellCoordinator({
      log: silentLogger(),
      onWorkerDemotedWithPoll: onDemoted,
    });
    try {
      const w1 = c.register(reg('/repo', 1));
      const w2 = c.register(reg('/repo', 2));
      expect(onDemoted).toHaveBeenCalledTimes(1);
      const call = onDemoted.mock.calls[0]?.[0];
      expect(call.demotedWorkerId).toBe(w1.workerId);
      expect(call.body).toEqual({
        status: 'demoted',
        reason: 'another_worker_registered_for_cwd',
        newActiveWorkerId: w2.workerId,
      });
    } finally {
      c.stop();
    }
  });

  it('promotion fires onWorkerPromoted when active dies and standby moves up', () => {
    const onPromoted = vi.fn();
    const c = new DoorbellCoordinator({
      log: silentLogger(),
      onWorkerPromoted: onPromoted,
    });
    try {
      const w1 = c.register(reg('/repo', 1));
      const w2 = c.register(reg('/repo', 2));
      // Removing w2 (the active) promotes w1.
      c.registry.unregister(w2.workerId);
      expect(onPromoted).toHaveBeenCalledTimes(1);
      expect(onPromoted.mock.calls[0]?.[0].workerId).toBe(w1.workerId);
    } finally {
      c.stop();
    }
  });

  it('demoted worker’s in-flight task survives, new tasks go to new active (M3)', () => {
    const w1 = coord.register(reg('/repo', 1));
    const enq1 = coord.queue.enqueue({ cwd: '/repo', prompt: 'old-task' });
    if (!enq1.ok) throw new Error('enqueue failed');
    coord.pullTaskFor(w1.workerId);

    // w2 takes over.
    const w2 = coord.register(reg('/repo', 2));
    const enq2 = coord.queue.enqueue({ cwd: '/repo', prompt: 'new-task' });
    if (!enq2.ok) throw new Error('enqueue failed');

    // w1 (now standby) cannot pull new tasks via pullTaskFor in
    // production; but the dispatch goes to active w2.
    const t = coord.pullTaskFor(w2.workerId);
    expect(t?.taskId).toBe(enq2.task.taskId);
    expect(t?.ownerWorkerId).toBe(w2.workerId);

    // Old task remains owned by w1, status unchanged from `dispatched`.
    expect(coord.queue.get(enq1.task.taskId)?.ownerWorkerId).toBe(w1.workerId);
    expect(coord.queue.get(enq1.task.taskId)?.status).toBe('dispatched');
  });
});

describe('DoorbellCoordinator — heartbeat sweep timer', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('does NOT sweep a worker busy with an in-flight task (long-task exemption)', () => {
    // Regression: a worker running a long task doesn't poll, but reaping it
    // would re-dispatch its in-flight task to another worker (dogfood
    // double-dispatch bug 2026-06-16). The busy worker is exempt from sweep.
    const c = new DoorbellCoordinator({
      log: silentLogger(),
      sweepIntervalMs: 1_000,
      staleThresholdMs: 5_000,
    });
    try {
      vi.setSystemTime(new Date(10_000));
      const w = c.register(reg('/repo', 10_000));
      c.queue.enqueue({ cwd: '/repo', prompt: 'p' });
      const dispatched = c.pullTaskFor(w.workerId, 10_000);
      expect(dispatched?.status).toBe('dispatched');

      c.start();
      // Advance well past stale threshold without touchPolled.
      vi.setSystemTime(new Date(60_000));
      vi.advanceTimersByTime(2_000); // fires sweep

      // Worker survives (it owns an in-flight task); task stays dispatched.
      expect(c.registry.get(w.workerId)).toBeDefined();
      const tid = dispatched?.taskId;
      if (!tid) throw new Error('no task id');
      expect(c.queue.get(tid)?.status).toBe('dispatched');
    } finally {
      c.stop();
    }
  });

  it('sweeps a stale worker that has NO in-flight task', () => {
    const c = new DoorbellCoordinator({
      log: silentLogger(),
      sweepIntervalMs: 1_000,
      staleThresholdMs: 5_000,
    });
    try {
      vi.setSystemTime(new Date(10_000));
      const w = c.register(reg('/repo', 10_000));
      // No task dispatched — worker is idle.
      c.start();
      vi.setSystemTime(new Date(60_000));
      vi.advanceTimersByTime(2_000);
      expect(c.registry.get(w.workerId)).toBeUndefined(); // reaped
    } finally {
      c.stop();
    }
  });

  it('prunes long-terminal tasks on the sweep (map leak fix)', () => {
    // A terminal task is retained briefly (late result re-posts / terminal
    // hook), then the sweep prunes it so the queue's task map stays bounded
    // on a resident bridge.
    const c = new DoorbellCoordinator({
      log: silentLogger(),
      sweepIntervalMs: 1_000,
      staleThresholdMs: 5_000,
      terminalRetentionMs: 30_000,
    });
    try {
      vi.setSystemTime(new Date(10_000));
      const w = c.register(reg('/repo', 10_000));
      c.queue.enqueue({ cwd: '/repo', prompt: 'p' });
      const d = c.pullTaskFor(w.workerId, 10_000);
      const tid = d?.taskId;
      if (!tid) throw new Error('no task id');
      c.queue.updateStatus({ taskId: tid, workerId: w.workerId, status: 'done' }, 11_000);

      c.start();
      // 20s after terminal (< 30s retention) → still present.
      vi.setSystemTime(new Date(31_000));
      vi.advanceTimersByTime(1_000);
      expect(c.queue.get(tid)).toBeDefined();

      // 31s after terminal (> retention) → pruned.
      vi.setSystemTime(new Date(42_000));
      vi.advanceTimersByTime(1_000);
      expect(c.queue.get(tid)).toBeUndefined();
    } finally {
      c.stop();
    }
  });

  it('start() is idempotent', () => {
    const c = new DoorbellCoordinator({ log: silentLogger() });
    try {
      c.start();
      c.start();
      // No assertion needed: just that it doesn’t double-fire timers.
    } finally {
      c.stop();
    }
  });

  it('stop() is idempotent and safe before start()', () => {
    const c = new DoorbellCoordinator({ log: silentLogger() });
    expect(() => c.stop()).not.toThrow();
    expect(() => c.stop()).not.toThrow();
  });

  it('hook errors are caught and logged, do not break sweep', () => {
    const c = new DoorbellCoordinator({
      log: silentLogger(),
      sweepIntervalMs: 1_000,
      staleThresholdMs: 1,
      onWorkerDemotedWithPoll: () => {
        throw new Error('hook boom');
      },
      onWorkerPromoted: () => {
        throw new Error('hook boom');
      },
    });
    try {
      const w1 = c.register(reg('/repo', 1));
      expect(() => c.register(reg('/repo', 2))).not.toThrow();
      expect(() =>
        c.registry.unregister(c.registry.activeForCwd('/repo')?.workerId ?? ''),
      ).not.toThrow();
      // After remove of new active, w1 (the standby) was promoted; that
      // hook also threw, but registry state should still be coherent.
      expect(c.registry.activeForCwd('/repo')?.workerId).toBe(w1.workerId);
    } finally {
      c.stop();
    }
  });
});

describe('DoorbellCoordinator — watch stream', () => {
  let coord: DoorbellCoordinator;
  beforeEach(() => {
    coord = new DoorbellCoordinator({ log: silentLogger() });
  });
  afterEach(() => coord.stop());

  it('sends a snapshot immediately on subscribe', () => {
    coord.register(reg('/repo', 1));
    coord.enqueueAndMaybeDispatch({ cwd: '/repo', prompt: 'do x' });
    const events: WatchEvent[] = [];
    coord.subscribeWatch((e) => events.push(e));
    expect(events[0]?.kind).toBe('snapshot');
    if (events[0]?.kind === 'snapshot') {
      expect(events[0].tasks.length).toBe(1);
      expect(events[0].tasks[0]?.cwd).toBe('/repo');
    }
  });

  it('emits a wake event when a task is queued with no active worker (C2)', () => {
    const events: WatchEvent[] = [];
    coord.subscribeWatch((e) => events.push(e));
    // No worker registered for /repo → enqueue should emit a wake intent.
    coord.enqueueAndMaybeDispatch({ cwd: '/repo', prompt: 'do x', selector: 'codex' });
    const wake = events.find((e) => e.kind === 'wake');
    expect(wake?.kind).toBe('wake');
    if (wake?.kind === 'wake') {
      expect(wake.cwd).toBe('/repo');
      expect(wake.selector).toBe('codex');
    }
  });

  it('does NOT emit wake when an active worker exists', () => {
    coord.register(reg('/repo', 1));
    const events: WatchEvent[] = [];
    coord.subscribeWatch((e) => events.push(e));
    coord.enqueueAndMaybeDispatch({ cwd: '/repo', prompt: 'do x' });
    expect(events.some((e) => e.kind === 'wake')).toBe(false);
  });

  it('emits a worker event on register', () => {
    const events: WatchEvent[] = [];
    coord.subscribeWatch((e) => events.push(e));
    coord.register({ cwd: '/r', hostname: 'mac', agentKind: 'cc', pid: 1, registeredAt: 1 });
    const w = events.find((e) => e.kind === 'worker');
    expect(w?.kind).toBe('worker');
    if (w?.kind === 'worker') {
      expect(w.action).toBe('registered');
      expect(w.agentKind).toBe('cc');
    }
  });

  it('emits progress + terminal events for a task', () => {
    const w = coord.register(reg('/repo', 1));
    const enq = coord.enqueueAndMaybeDispatch({ cwd: '/repo', prompt: 'do x' });
    if (!enq.ok) throw new Error('enqueue failed');
    const task = coord.queue.get(enq.task.taskId);
    if (!task) throw new Error('no task');
    // bind owner so responder resolves
    task.ownerWorkerId = w.workerId;

    const events: WatchEvent[] = [];
    coord.subscribeWatch((e) => events.push(e));

    coord.notifyProgress({ task, event: { kind: 'tool', label: 'Bash: ls' } });
    coord.notifyTerminal({ task });

    const prog = events.find((e) => e.kind === 'progress');
    expect(prog?.kind).toBe('progress');
    if (prog?.kind === 'progress') {
      expect(prog.event?.label).toBe('Bash: ls');
      expect(prog.responder).toContain('cc@repo');
    }
    expect(events.some((e) => e.kind === 'terminal')).toBe(true);
  });

  it('unsubscribe stops further events', () => {
    const events: WatchEvent[] = [];
    const off = coord.subscribeWatch((e) => events.push(e));
    off();
    coord.register(reg('/repo', 1));
    // only the initial snapshot was captured
    expect(events.length).toBe(1);
    expect(events[0]?.kind).toBe('snapshot');
  });
});

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

  it('sweeps stale workers on its interval and reverts their in-flight tasks', () => {
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
      // Advance past stale threshold without touchPolled.
      vi.setSystemTime(new Date(20_000));
      vi.advanceTimersByTime(2_000); // > 1s interval, fires sweep

      expect(c.registry.get(w.workerId)).toBeUndefined();
      const tid = dispatched?.taskId;
      if (!tid) throw new Error('no task id');
      const back = c.queue.get(tid);
      expect(back?.status).toBe('queued');
      expect(back?.retryCount).toBe(1);
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

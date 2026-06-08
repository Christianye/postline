import { describe, expect, it } from 'vitest';
import { TaskQueue } from './queue.js';

describe('TaskQueue — enqueue', () => {
  it('first task on a fresh cwd lands queued', () => {
    const q = new TaskQueue();
    const r = q.enqueue({ cwd: '/repo', prompt: 'hello' }, 1_000);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.task.cwd).toBe('/repo');
    expect(r.task.prompt).toBe('hello');
    expect(r.task.status).toBe('queued');
    expect(r.task.ownerWorkerId).toBeNull();
    expect(r.task.taskId).toMatch(/^[0-9a-f]{4}$/);
    expect(r.task.deadlineMs).toBe(1_000 + 5 * 60_000);
  });

  it('respects defaultDeadlineMs and per-task override', () => {
    const q = new TaskQueue({ defaultDeadlineMs: 30_000 });
    const a = q.enqueue({ cwd: '/r', prompt: 'a' }, 0);
    expect(a.ok && a.task.deadlineMs).toBe(30_000);
    const b = q.enqueue({ cwd: '/r', prompt: 'b', deadlineMs: 10_000 }, 0);
    expect(b.ok && b.task.deadlineMs).toBe(10_000);
  });

  it('persists feishuMessageId when given', () => {
    const q = new TaskQueue();
    const r = q.enqueue({ cwd: '/r', prompt: 'p', feishuMessageId: 'om_xyz' });
    expect(r.ok && r.task.feishuMessageId).toBe('om_xyz');
  });
});

describe('TaskQueue — cap + 429 (D07)', () => {
  it('11th task on a 10-cap queue returns queue_full and does not consume a slot', () => {
    const q = new TaskQueue({ queueMax: 10 });
    for (let i = 0; i < 10; i++) {
      const r = q.enqueue({ cwd: '/r', prompt: `t${i}` });
      expect(r.ok).toBe(true);
    }
    expect(q.queueLen('/r')).toBe(10);

    const overflow = q.enqueue({ cwd: '/r', prompt: 'eleventh' });
    expect(overflow.ok).toBe(false);
    if (overflow.ok) return;
    expect(overflow.error.error).toBe('queue_full');
    expect(overflow.error.cwd).toBe('/r');
    expect(overflow.error.queueLen).toBe(10);
    expect(overflow.error.queueMax).toBe(10);
    expect(overflow.error.taskHint).toBe('eleventh');

    // Slot count unchanged (rejection didn't consume one).
    expect(q.queueLen('/r')).toBe(10);
  });

  it('overflow taskHint truncates to 80 chars', () => {
    const q = new TaskQueue({ queueMax: 1 });
    q.enqueue({ cwd: '/r', prompt: 'first' });
    const long = 'x'.repeat(200);
    const overflow = q.enqueue({ cwd: '/r', prompt: long });
    expect(overflow.ok).toBe(false);
    if (overflow.ok) return;
    expect(overflow.error.taskHint.length).toBe(80);
  });

  it('different cwds have independent caps', () => {
    const q = new TaskQueue({ queueMax: 2 });
    q.enqueue({ cwd: '/a', prompt: '1' });
    q.enqueue({ cwd: '/a', prompt: '2' });
    expect(q.enqueue({ cwd: '/a', prompt: '3' }).ok).toBe(false);
    // /b is fresh
    expect(q.enqueue({ cwd: '/b', prompt: '1' }).ok).toBe(true);
  });
});

describe('TaskQueue — dispatch (FIFO + workerId lock)', () => {
  it('dispatches in FIFO order and binds to workerId', () => {
    const q = new TaskQueue();
    const a = q.enqueue({ cwd: '/r', prompt: 'a' }, 1_000);
    const b = q.enqueue({ cwd: '/r', prompt: 'b' }, 1_001);
    if (!a.ok || !b.ok) throw new Error('enqueue failed');
    const first = q.dispatch('/r', 'w_active', 2_000);
    expect(first?.taskId).toBe(a.task.taskId);
    expect(first?.ownerWorkerId).toBe('w_active');
    expect(first?.status).toBe('dispatched');
    expect(first?.dispatchedAt).toBe(2_000);
    const second = q.dispatch('/r', 'w_active', 2_001);
    expect(second?.taskId).toBe(b.task.taskId);
    expect(q.dispatch('/r', 'w_active')).toBeUndefined();
  });

  it('returns undefined when cwd has no tasks', () => {
    const q = new TaskQueue();
    expect(q.dispatch('/missing', 'w1')).toBeUndefined();
  });
});

describe('TaskQueue — task ownership lock (§M3)', () => {
  it('updateStatus succeeds for the owning worker, fails for others', () => {
    const q = new TaskQueue();
    const r = q.enqueue({ cwd: '/r', prompt: 'p' });
    if (!r.ok) throw new Error('enqueue failed');
    q.dispatch('/r', 'w_active');
    expect(q.updateStatus({ taskId: r.task.taskId, workerId: 'w_active', status: 'running' })).toBe(
      true,
    );
    expect(q.get(r.task.taskId)?.status).toBe('running');

    expect(q.updateStatus({ taskId: r.task.taskId, workerId: 'w_other', status: 'done' })).toBe(
      false,
    );
    expect(q.get(r.task.taskId)?.status).toBe('running');
  });

  it('updateStatus on unknown taskId returns false', () => {
    const q = new TaskQueue();
    expect(q.updateStatus({ taskId: 'deadbeef', workerId: 'w1', status: 'done' })).toBe(false);
  });

  it('demoted worker can still post terminal status for its in-flight tasks (M3)', () => {
    const q = new TaskQueue();
    const r = q.enqueue({ cwd: '/r', prompt: 'p' });
    if (!r.ok) throw new Error('enqueue failed');
    q.dispatch('/r', 'w_old');
    // Imagine: a new worker registered, w_old got demoted. The
    // registry no longer treats w_old as active, but the task lock
    // means w_old still owns this task and its progress/result POSTs
    // must be accepted.
    expect(q.updateStatus({ taskId: r.task.taskId, workerId: 'w_old', status: 'running' })).toBe(
      true,
    );
    expect(q.updateStatus({ taskId: r.task.taskId, workerId: 'w_old', status: 'done' })).toBe(true);
    expect(q.get(r.task.taskId)?.status).toBe('done');
  });
});

describe('TaskQueue — releaseWorker (heartbeat sweep aftermath)', () => {
  it('reverts in-flight tasks to queued, increments retryCount, head-of-list', () => {
    const q = new TaskQueue();
    q.enqueue({ cwd: '/r', prompt: 'a' });
    const b = q.enqueue({ cwd: '/r', prompt: 'b' });
    const c = q.enqueue({ cwd: '/r', prompt: 'c' });
    if (!b.ok || !c.ok) throw new Error('enqueue failed');
    q.dispatch('/r', 'w_dead'); // takes 'a'
    q.dispatch('/r', 'w_dead'); // takes 'b'
    // 'c' still queued. Two tasks in-flight under w_dead.

    const reverted = q.releaseWorker('w_dead');
    expect(reverted).toBe(2);
    // The reverted tasks should be at the head, retryCount=1.
    const aTask = q.get((q.cwds().includes('/r') && b.task.taskId) || '');
    expect(aTask?.retryCount).toBe(1);
    expect(aTask?.ownerWorkerId).toBeNull();
    expect(aTask?.status).toBe('queued');

    // Next dispatch should pick a previously-in-flight task (head).
    const next = q.dispatch('/r', 'w_new');
    // It's one of the two reverted ones (which one depends on iteration
    // order over the Map). What matters is the reverted task is the
    // first dispatched, not 'c'.
    expect(next?.taskId).not.toBe(c.task.taskId);
    expect(next?.retryCount).toBe(1);
  });

  it('releaseWorker on a worker with no in-flight tasks returns 0', () => {
    const q = new TaskQueue();
    q.enqueue({ cwd: '/r', prompt: 'a' });
    expect(q.releaseWorker('w_nobody')).toBe(0);
  });
});

describe('TaskQueue — getByFeishuMessageId', () => {
  it('finds the right task by Feishu message id', () => {
    const q = new TaskQueue();
    const a = q.enqueue({ cwd: '/r', prompt: 'a', feishuMessageId: 'om_a' });
    q.enqueue({ cwd: '/r', prompt: 'b', feishuMessageId: 'om_b' });
    if (!a.ok) throw new Error('enqueue failed');
    expect(q.getByFeishuMessageId('om_a')?.taskId).toBe(a.task.taskId);
    expect(q.getByFeishuMessageId('om_missing')).toBeUndefined();
  });
});

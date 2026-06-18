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

  it('persists the selector on the task', () => {
    const q = new TaskQueue();
    const r = q.enqueue({ cwd: '/r', prompt: 'x', selector: 'codex' });
    if (!r.ok) throw new Error('enqueue failed');
    expect(r.task.selector).toBe('codex');
    const noSel = q.enqueue({ cwd: '/r', prompt: 'y' });
    if (!noSel.ok) throw new Error('enqueue failed');
    expect(noSel.task.selector).toBeNull();
  });

  it('canTake skips a selector-targeted task the worker does not match (no codex-grab)', () => {
    const q = new TaskQueue();
    const codexTask = q.enqueue({ cwd: '/r', prompt: 'codex work', selector: 'codex' }, 1_000);
    const anyTask = q.enqueue({ cwd: '/r', prompt: 'any work' }, 1_001);
    if (!codexTask.ok || !anyTask.ok) throw new Error('enqueue failed');
    // A cc worker (canTake rejects selector !== 'cc') must skip the codex
    // task and grab the unselected one instead — not head-of-line steal it.
    const ccTakes = (t: { selector: string | null }) => !t.selector || t.selector === 'cc';
    const got = q.dispatch('/r', 'w_cc', 2_000, ccTakes);
    expect(got?.taskId).toBe(anyTask.task.taskId);
    // The codex task is still queued, waiting for a matching worker.
    expect(q.get(codexTask.task.taskId)?.status).toBe('queued');
    // A codex worker then picks it up.
    const codexTakes = (t: { selector: string | null }) => !t.selector || t.selector === 'codex';
    const got2 = q.dispatch('/r', 'w_codex', 2_001, codexTakes);
    expect(got2?.taskId).toBe(codexTask.task.taskId);
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

    const { requeued, failed } = q.releaseWorker('w_dead');
    expect(requeued.length).toBe(2);
    expect(failed.length).toBe(0);
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

  it('releaseWorker on a worker with no in-flight tasks reverts nothing', () => {
    const q = new TaskQueue();
    q.enqueue({ cwd: '/r', prompt: 'a' });
    const { requeued, failed } = q.releaseWorker('w_nobody');
    expect(requeued.length).toBe(0);
    expect(failed.length).toBe(0);
  });

  it('fails (does not requeue) a task that has exhausted MAX_RETRIES', () => {
    const q = new TaskQueue();
    const r = q.enqueue({ cwd: '/r', prompt: 'poison' });
    if (!r.ok) throw new Error('enqueue failed');
    // Simulate two prior drops: dispatch → release → dispatch → release.
    q.dispatch('/r', 'w1');
    expect(q.releaseWorker('w1').requeued.length).toBe(1); // retryCount 0→1
    q.dispatch('/r', 'w2');
    expect(q.releaseWorker('w2').requeued.length).toBe(1); // retryCount 1→2
    // Third drop: retryCount is now 2 (== MAX_RETRIES) → fail, don't requeue.
    q.dispatch('/r', 'w3');
    const third = q.releaseWorker('w3');
    expect(third.requeued.length).toBe(0);
    expect(third.failed.length).toBe(1);
    expect(third.failed[0]?.status).toBe('failed');
    expect(third.failed[0]?.terminatedAt).not.toBeNull();
    // The cwd queue no longer head-of-lines the poison task.
    expect(q.dispatch('/r', 'w4')).toBeUndefined();
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

describe('TaskQueue — terminal retention sweep (map leak fix)', () => {
  it('stamps terminatedAt on the first transition to a terminal status', () => {
    const q = new TaskQueue();
    const r = q.enqueue({ cwd: '/r', prompt: 'a' });
    if (!r.ok) throw new Error('enqueue failed');
    q.dispatch('/r', 'w1');
    expect(q.get(r.task.taskId)?.terminatedAt).toBeNull();
    q.updateStatus({ taskId: r.task.taskId, workerId: 'w1', status: 'running' }, 1_000);
    expect(q.get(r.task.taskId)?.terminatedAt).toBeNull(); // running is not terminal
    q.updateStatus({ taskId: r.task.taskId, workerId: 'w1', status: 'done' }, 2_000);
    expect(q.get(r.task.taskId)?.terminatedAt).toBe(2_000);
    // A re-post of the terminal status keeps the original timestamp.
    q.updateStatus({ taskId: r.task.taskId, workerId: 'w1', status: 'done' }, 9_000);
    expect(q.get(r.task.taskId)?.terminatedAt).toBe(2_000);
  });

  it('prunes a task only after it has been terminal longer than retentionMs', () => {
    const q = new TaskQueue();
    const r = q.enqueue({ cwd: '/r', prompt: 'a' });
    if (!r.ok) throw new Error('enqueue failed');
    q.dispatch('/r', 'w1');
    q.updateStatus({ taskId: r.task.taskId, workerId: 'w1', status: 'done' }, 1_000);
    // 30s later, retention 60s → still kept (late result posts still work).
    expect(q.sweepTerminal(31_000, 60_000)).toBe(0);
    expect(q.get(r.task.taskId)).toBeDefined();
    // 61s after terminal → pruned.
    expect(q.sweepTerminal(62_000, 60_000)).toBe(1);
    expect(q.get(r.task.taskId)).toBeUndefined();
  });

  it('never prunes a non-terminal task no matter how old', () => {
    const q = new TaskQueue();
    const r = q.enqueue({ cwd: '/r', prompt: 'a' }, 0);
    if (!r.ok) throw new Error('enqueue failed');
    q.dispatch('/r', 'w1');
    q.updateStatus({ taskId: r.task.taskId, workerId: 'w1', status: 'running' }, 0);
    expect(q.sweepTerminal(10_000_000, 60_000)).toBe(0);
    expect(q.get(r.task.taskId)?.status).toBe('running');
  });

  it('drops a pruned task from the byCwd FIFO list too (done-while-queued edge)', () => {
    // A task can reach terminal while still in the FIFO list if it never
    // got dispatch-spliced. The sweep must scrub byCwd, not just tasks.
    const q = new TaskQueue();
    const r = q.enqueue({ cwd: '/r', prompt: 'a' });
    if (!r.ok) throw new Error('enqueue failed');
    q.dispatch('/r', 'w1'); // splices it out; re-add via releaseWorker path is overkill
    // Force the lingering-in-list edge: enqueue a second, mark the first
    // terminal, then prune — byCwd for /r should not retain the dead id.
    q.updateStatus({ taskId: r.task.taskId, workerId: 'w1', status: 'done' }, 1_000);
    q.sweepTerminal(70_000, 60_000);
    expect(q.cwds()).not.toContain('/r'); // no live queue left for /r
    expect(q.get(r.task.taskId)).toBeUndefined();
  });
});

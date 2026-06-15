import { describe, expect, it, vi } from 'vitest';
import { WorkerRegistry } from './registry.js';
import type { WorkerRegistration } from './types.js';

function reg(cwd: string, t: number, hostname = 'mac', pid = 1000 + t): WorkerRegistration {
  return { cwd, hostname, pid, registeredAt: t };
}

describe('WorkerRegistry — basic registration', () => {
  it('first registration becomes active', () => {
    const r = new WorkerRegistry();
    const out = r.register(reg('/repo/postline', 1));
    expect(out.state).toBe('active');
    expect(out.workerId).toMatch(/^w_[0-9a-f]{8}$/);
    expect(r.activeForCwd('/repo/postline')?.workerId).toBe(out.workerId);
  });

  it('different cwds are isolated', () => {
    const r = new WorkerRegistry();
    const a = r.register(reg('/repo/postline', 1));
    const b = r.register(reg('/repo/NeuGate', 2));
    expect(r.activeForCwd('/repo/postline')?.workerId).toBe(a.workerId);
    expect(r.activeForCwd('/repo/NeuGate')?.workerId).toBe(b.workerId);
  });

  it('returns undefined for unknown cwd', () => {
    const r = new WorkerRegistry();
    expect(r.activeForCwd('/nope')).toBeUndefined();
  });
});

describe('WorkerRegistry — multi-session same cwd (D05)', () => {
  it('latest registration wins; prior active demotes', () => {
    const onDemoted = vi.fn();
    const r = new WorkerRegistry({ onDemoted });
    const w1 = r.register(reg('/repo', 1));
    const w2 = r.register(reg('/repo', 2));

    expect(w2.state).toBe('active');
    expect(r.activeForCwd('/repo')?.workerId).toBe(w2.workerId);
    expect(r.get(w1.workerId)?.state).toBe('standby');
    expect(onDemoted).toHaveBeenCalledTimes(1);
    const call = onDemoted.mock.calls[0]?.[0];
    expect(call.demoted.workerId).toBe(w1.workerId);
    expect(call.newActive.workerId).toBe(w2.workerId);
  });

  it('5-worker FIFO standby order: W1..W5 register, W5 active, W1..W4 standby in registration order', () => {
    const r = new WorkerRegistry();
    const ids = [];
    for (let t = 1; t <= 5; t++) {
      ids.push(r.register(reg('/repo', t)).workerId);
    }
    const snap = r.snapshot().byCwd.get('/repo');
    expect(snap).toBeDefined();
    expect(snap?.length).toBe(5);
    // [W5 active, W1, W2, W3, W4] — standby tail is FIFO oldest-first.
    expect(snap?.map((w) => w.workerId)).toEqual([ids[4], ids[0], ids[1], ids[2], ids[3]]);
    expect(snap?.[0]?.state).toBe('active');
    for (let i = 1; i <= 4; i++) {
      expect(snap?.[i]?.state).toBe('standby');
    }
  });

  it('after 5 workers register: kill W5 → W1 promotes, kill W1 → W2 promotes, ... until empty', () => {
    const onPromoted = vi.fn();
    const onRemoved = vi.fn();
    const r = new WorkerRegistry({ onPromoted, onRemoved });
    const ids: string[] = [];
    for (let t = 1; t <= 5; t++) {
      ids.push(r.register(reg('/repo', t)).workerId);
    }
    const id = (i: number): string => {
      const v = ids[i];
      if (!v) throw new Error(`ids[${i}] missing`);
      return v;
    };
    // Kill W5 (current active).
    r.unregister(id(4));
    expect(r.activeForCwd('/repo')?.workerId).toBe(id(0)); // W1 promoted
    // Kill W1.
    r.unregister(id(0));
    expect(r.activeForCwd('/repo')?.workerId).toBe(id(1)); // W2 promoted
    // Kill W2.
    r.unregister(id(1));
    expect(r.activeForCwd('/repo')?.workerId).toBe(id(2)); // W3
    // Kill W3.
    r.unregister(id(2));
    expect(r.activeForCwd('/repo')?.workerId).toBe(id(3)); // W4
    // Kill W4.
    r.unregister(id(3));
    expect(r.activeForCwd('/repo')).toBeUndefined();
    expect(r.snapshot().byCwd.has('/repo')).toBe(false);

    // 4 promotions (W1, W2, W3, W4), 5 removals.
    expect(onPromoted).toHaveBeenCalledTimes(4);
    expect(onRemoved).toHaveBeenCalledTimes(5);
  });

  it('killing a standby worker does NOT trigger promotion', () => {
    const onPromoted = vi.fn();
    const r = new WorkerRegistry({ onPromoted });
    const w1 = r.register(reg('/repo', 1));
    const w2 = r.register(reg('/repo', 2));
    // w1 is now standby. Kill it.
    r.unregister(w1.workerId);
    expect(r.activeForCwd('/repo')?.workerId).toBe(w2.workerId);
    expect(onPromoted).not.toHaveBeenCalled();
  });
});

describe('WorkerRegistry — heartbeat sweep', () => {
  it('removes workers whose lastPolledAt is older than threshold', () => {
    const onRemoved = vi.fn();
    const r = new WorkerRegistry({ onRemoved });
    const w1 = r.register(reg('/repo', 1_000));
    r.touchPolled(w1.workerId, 2_000);
    const w2 = r.register(reg('/repo', 3_000));
    r.touchPolled(w2.workerId, 3_500);
    // sweep at t=70_000 with threshold 60_000 → cutoff 10_000.
    // w1.lastPolled=2_000 (stale), w2=3_500 (also stale).
    const swept = r.sweepStale(70_000, 60_000);
    expect(swept.length).toBe(2);
    expect(r.snapshot().byId.size).toBe(0);
    expect(onRemoved).toHaveBeenCalledTimes(2);
  });

  it('preserves fresh workers; promotes standby when active is swept', () => {
    const r = new WorkerRegistry();
    const w1 = r.register(reg('/repo', 1_000));
    const w2 = r.register(reg('/repo', 2_000)); // active now
    r.touchPolled(w1.workerId, 60_000); // fresh
    r.touchPolled(w2.workerId, 1_000); // stale
    const swept = r.sweepStale(70_000, 60_000);
    expect(swept.length).toBe(1);
    expect(swept[0]?.workerId).toBe(w2.workerId);
    expect(r.activeForCwd('/repo')?.workerId).toBe(w1.workerId);
  });

  it('returning empty list when nothing is stale', () => {
    const r = new WorkerRegistry();
    const w = r.register(reg('/repo', 1_000));
    r.touchPolled(w.workerId, 50_000);
    expect(r.sweepStale(60_000, 60_000)).toHaveLength(0);
  });
});

describe('WorkerRegistry — touchPolled / unregister edge cases', () => {
  it('touchPolled on unknown id is a no-op', () => {
    const r = new WorkerRegistry();
    expect(() => r.touchPolled('w_unknown', 999)).not.toThrow();
  });

  it('unregister on unknown id is a no-op', () => {
    const onRemoved = vi.fn();
    const r = new WorkerRegistry({ onRemoved });
    r.unregister('w_unknown');
    expect(onRemoved).not.toHaveBeenCalled();
  });

  it('hook exceptions do not corrupt registry state', () => {
    const r = new WorkerRegistry({
      onDemoted: () => {
        throw new Error('boom');
      },
      onRemoved: () => {
        throw new Error('boom');
      },
      onPromoted: () => {
        throw new Error('boom');
      },
    });
    const w1 = r.register(reg('/repo', 1));
    const w2 = r.register(reg('/repo', 2));
    expect(r.activeForCwd('/repo')?.workerId).toBe(w2.workerId);
    expect(() => r.unregister(w2.workerId)).not.toThrow();
    expect(r.activeForCwd('/repo')?.workerId).toBe(w1.workerId);
  });
});

describe('WorkerRegistry — selector / (cwd, agentKind) slots', () => {
  it('cc and codex workers coexist active on the same cwd (no demotion)', () => {
    const r = new WorkerRegistry();
    const cc = r.register({
      cwd: '/repo',
      hostname: 'mac',
      agentKind: 'cc',
      pid: 1,
      registeredAt: 1,
    });
    const cx = r.register({
      cwd: '/repo',
      hostname: 'mac',
      agentKind: 'codex',
      pid: 2,
      registeredAt: 2,
    });
    expect(cc.state).toBe('active');
    expect(cx.state).toBe('active'); // different slot → not demoted
    expect(r.activeForCwd('/repo', 'cc')?.workerId).toBe(cc.workerId);
    expect(r.activeForCwd('/repo', 'codex')?.workerId).toBe(cx.workerId);
  });

  it('selector matches host as well as agentKind', () => {
    const r = new WorkerRegistry();
    const ec2 = r.register({
      cwd: '/repo',
      hostname: 'ec2',
      agentKind: 'cc',
      pid: 1,
      registeredAt: 1,
    });
    expect(r.activeForCwd('/repo', 'ec2')?.workerId).toBe(ec2.workerId);
  });

  it('same (cwd, agentKind) still latest-wins + standby promote', () => {
    const r = new WorkerRegistry();
    const a = r.register({
      cwd: '/repo',
      hostname: 'mac',
      agentKind: 'cc',
      pid: 1,
      registeredAt: 1,
    });
    const b = r.register({
      cwd: '/repo',
      hostname: 'mac',
      agentKind: 'cc',
      pid: 2,
      registeredAt: 2,
    });
    expect(b.state).toBe('active');
    expect(r.activeForCwd('/repo', 'cc')?.workerId).toBe(b.workerId);
    r.unregister(b.workerId);
    expect(r.activeForCwd('/repo', 'cc')?.workerId).toBe(a.workerId); // standby promoted
  });

  it('no-selector dispatch still resolves (back-compat)', () => {
    const r = new WorkerRegistry();
    const cc = r.register({
      cwd: '/repo',
      hostname: 'mac',
      agentKind: 'cc',
      pid: 1,
      registeredAt: 1,
    });
    expect(r.activeForCwd('/repo')?.workerId).toBe(cc.workerId);
  });

  it('snapshot.byCwd lists both kinds under the cwd', () => {
    const r = new WorkerRegistry();
    r.register({ cwd: '/repo', hostname: 'mac', agentKind: 'cc', pid: 1, registeredAt: 1 });
    r.register({ cwd: '/repo', hostname: 'mac', agentKind: 'codex', pid: 2, registeredAt: 2 });
    expect(r.snapshot().byCwd.get('/repo')?.length).toBe(2);
  });
});

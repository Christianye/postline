import { describe, expect, it } from 'vitest';
import { createPendingActions } from './pending-actions.js';

describe('pending-actions', () => {
  it('resolves true on approve', async () => {
    const store = createPendingActions();
    const p = store.create({
      id: 'a1',
      tool: 'bash',
      args: { command: 'ls' },
      userId: 'ou_u',
      conversationId: 'oc_1',
      ttlMs: 10_000,
    });
    expect(store.approve('a1')).toBe(true);
    expect(await p).toBe(true);
  });

  it('resolves false on deny', async () => {
    const store = createPendingActions();
    const p = store.create({
      id: 'b1',
      tool: 'bash',
      args: {},
      userId: 'ou_u',
      conversationId: 'oc_1',
      ttlMs: 10_000,
    });
    expect(store.deny('b1')).toBe(true);
    expect(await p).toBe(false);
  });

  it('returns false for unknown ids', () => {
    const store = createPendingActions();
    expect(store.approve('nope')).toBe(false);
  });

  it('expires pending actions after ttl', async () => {
    const store = createPendingActions();
    const p = store.create({
      id: 'c1',
      tool: 'bash',
      args: {},
      userId: 'ou_u',
      conversationId: 'oc_1',
      ttlMs: 20,
    });
    expect(await p).toBe(false);
  });

  it('get returns the entry without resolving it', async () => {
    const store = createPendingActions();
    const p = store.create({
      id: 'g1',
      tool: 'bash',
      args: { command: 'ls' },
      userId: 'ou_u',
      conversationId: 'oc_1',
      ttlMs: 10_000,
    });
    const entry = store.get('g1');
    expect(entry?.tool).toBe('bash');
    expect(entry?.args).toEqual({ command: 'ls' });
    // get() must not race the pending promise — it should still be pending.
    let settled = false;
    void p.then(() => {
      settled = true;
    });
    await new Promise((r) => setTimeout(r, 5));
    expect(settled).toBe(false);
    // approve still works after a get()
    expect(store.approve('g1')).toBe(true);
    expect(await p).toBe(true);
  });

  it('get returns undefined for unknown / already-resolved ids', () => {
    const store = createPendingActions();
    expect(store.get('never-existed')).toBeUndefined();
    void store.create({
      id: 'g2',
      tool: 'bash',
      args: {},
      userId: 'ou_u',
      conversationId: 'oc_1',
      ttlMs: 10_000,
    });
    store.deny('g2');
    expect(store.get('g2')).toBeUndefined();
  });

  it('list filters by conversationId', async () => {
    const store = createPendingActions();
    void store.create({
      id: 'x1',
      tool: 'bash',
      args: {},
      userId: 'ou_u',
      conversationId: 'oc_a',
      ttlMs: 10_000,
    });
    void store.create({
      id: 'x2',
      tool: 'bash',
      args: {},
      userId: 'ou_u',
      conversationId: 'oc_b',
      ttlMs: 10_000,
    });
    expect(store.list('oc_a').map((p) => p.id)).toEqual(['x1']);
    expect(store.list('oc_b').map((p) => p.id)).toEqual(['x2']);
    expect(store.list().length).toBe(2);
    // clean up
    store.deny('x1');
    store.deny('x2');
  });
});

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

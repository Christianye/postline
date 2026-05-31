import type { PendingAction } from '@postline/core';
import { describe, expect, it, vi } from 'vitest';
import { authorizeApproval } from './cmd-feishu.js';

function silentLog() {
  return { info: vi.fn(), warn: vi.fn() };
}

function entry(overrides: Partial<PendingAction> = {}): PendingAction {
  return {
    id: 'a1',
    tool: 'bash',
    args: { cmd: 'ls' },
    userId: 'ou_requester',
    conversationId: 'oc_chat',
    expiresAt: Date.now() + 60_000,
    resolve: () => undefined,
    ...overrides,
  };
}

describe('authorizeApproval', () => {
  it('denies when entry is missing (expired / never existed)', () => {
    const log = silentLog();
    const out = authorizeApproval(
      {
        actionId: 'a1',
        clickerOpenId: 'ou_x',
        entry: undefined,
        requesterOnly: true,
        admins: new Set(),
      },
      log,
    );
    expect(out).toEqual({ kind: 'deny', toast: 'Action expired or already resolved.' });
  });

  it('allows anyone when requesterOnly=false', () => {
    const log = silentLog();
    const out = authorizeApproval(
      {
        actionId: 'a1',
        clickerOpenId: 'ou_someone_else',
        entry: entry(),
        requesterOnly: false,
        admins: new Set(),
      },
      log,
    );
    expect(out).toEqual({ kind: 'allow' });
    expect(log.info).not.toHaveBeenCalled();
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('allows the requester when requesterOnly=true', () => {
    const log = silentLog();
    const out = authorizeApproval(
      {
        actionId: 'a1',
        clickerOpenId: 'ou_requester',
        entry: entry(),
        requesterOnly: true,
        admins: new Set(),
      },
      log,
    );
    expect(out).toEqual({ kind: 'allow' });
    // No override / rejection logs for the happy path.
    expect(log.info).not.toHaveBeenCalled();
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('rejects a non-requester non-admin and logs a warning', () => {
    const log = silentLog();
    const out = authorizeApproval(
      {
        actionId: 'a1',
        clickerOpenId: 'ou_intruder',
        entry: entry(),
        requesterOnly: true,
        admins: new Set(['ou_admin']),
      },
      log,
    );
    expect(out.kind).toBe('deny');
    if (out.kind === 'deny') {
      expect(out.toast).toMatch(/requester/);
    }
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        actionId: 'a1',
        requester: 'ou_requester',
        clicker: 'ou_intruder',
      }),
      'feishu_approval_rejected_not_requester',
    );
  });

  it('allows an admin override and logs an audit event', () => {
    const log = silentLog();
    const out = authorizeApproval(
      {
        actionId: 'a1',
        clickerOpenId: 'ou_admin',
        entry: entry(),
        requesterOnly: true,
        admins: new Set(['ou_admin', 'ou_other_admin']),
      },
      log,
    );
    expect(out).toEqual({ kind: 'allow' });
    expect(log.info).toHaveBeenCalledTimes(1);
    expect(log.info).toHaveBeenCalledWith(
      expect.objectContaining({
        actionId: 'a1',
        requester: 'ou_requester',
        override_by: 'ou_admin',
        tool: 'bash',
      }),
      'feishu_approval_override',
    );
  });

  it('admin who is also the requester just allows — no override log', () => {
    const log = silentLog();
    const out = authorizeApproval(
      {
        actionId: 'a1',
        clickerOpenId: 'ou_requester',
        entry: entry({ userId: 'ou_requester' }),
        requesterOnly: true,
        admins: new Set(['ou_requester']),
      },
      log,
    );
    expect(out).toEqual({ kind: 'allow' });
    // The requester branch wins before the admin branch — no override log.
    expect(log.info).not.toHaveBeenCalled();
  });
});

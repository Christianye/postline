import { describe, expect, it } from 'vitest';
import { buildApprovalBlocks, buildResolvedBlocks, parseBlockActions } from './approval.js';

describe('buildApprovalBlocks', () => {
  it('builds approve/deny buttons with verb:actionId values', () => {
    const blocks = buildApprovalBlocks({ actionId: 'a1b2c3d4', toolName: 'bash', ttlMinutes: 5 });
    const actions = blocks.find((b) => b.type === 'actions') as unknown as {
      elements: Array<{ action_id: string; value: string }>;
    };
    expect(actions.elements[0]?.value).toBe('approve:a1b2c3d4');
    expect(actions.elements[1]?.value).toBe('deny:a1b2c3d4');
  });
});

describe('parseBlockActions', () => {
  it('parses a block_actions payload', () => {
    const parsed = parseBlockActions({
      type: 'block_actions',
      user: { id: 'U1' },
      channel: { id: 'C1' },
      message: { ts: '9.9' },
      actions: [{ value: 'approve:a1b2c3d4' }],
    });
    expect(parsed).toEqual({
      action: 'approve',
      actionId: 'a1b2c3d4',
      userId: 'U1',
      channel: 'C1',
      ts: '9.9',
    });
  });

  it('rejects non-block_actions / malformed', () => {
    expect(parseBlockActions({ type: 'view_submission' })).toBeNull();
    expect(parseBlockActions({ type: 'block_actions', actions: [{ value: 'junk' }] })).toBeNull();
  });
});

describe('buildResolvedBlocks', () => {
  it('renders an approved resolution mentioning the actor', () => {
    const blocks = buildResolvedBlocks({
      toolName: 'bash',
      actionId: 'a1b2c3d4',
      decision: 'approve',
      actorId: 'U1',
    });
    const text = JSON.stringify(blocks);
    expect(text).toContain('Approved');
    expect(text).toContain('<@U1>');
  });
});

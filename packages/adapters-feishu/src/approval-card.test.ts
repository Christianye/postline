import { describe, expect, it } from 'vitest';
import { buildApprovalCard, buildResolvedCard } from './index.js';

describe('buildApprovalCard', () => {
  function sample(overrides: Partial<Parameters<typeof buildApprovalCard>[0]> = {}) {
    return buildApprovalCard({
      conversationId: 'oc_chat',
      actionId: '3f9a2c7b',
      toolName: 'bash',
      argsPreview: '{"cmd":"rm -rf /tmp/foo"}',
      ttlMinutes: 5,
      ...overrides,
    });
  }

  it('produces a card with a header naming the tool', () => {
    const card = sample() as {
      header: { title: { content: string }; template: string };
    };
    expect(card.header.title.content).toMatch(/bash/);
    // dangerous = red header
    expect(card.header.template).toBe('red');
  });

  it('embeds the args preview in the body', () => {
    const card = sample() as { elements: Array<{ text?: { content: string } }> };
    const body = card.elements.find((e) => e.text?.content?.includes('rm -rf'));
    expect(body).toBeDefined();
  });

  it('truncates very long args previews with an ellipsis', () => {
    const card = sample({ argsPreview: 'x'.repeat(600) }) as {
      elements: Array<{ text?: { content: string } }>;
    };
    const body = card.elements.find((e) => e.text?.content?.includes('xxx'));
    expect(body?.text?.content).toMatch(/…/);
  });

  it('creates two buttons with approve/deny values carrying actionId', () => {
    const card = sample() as {
      elements: Array<{
        actions?: Array<{ text: { content: string }; value: Record<string, string> }>;
      }>;
    };
    const actionsEl = card.elements.find((e) => Array.isArray(e.actions));
    expect(actionsEl?.actions).toHaveLength(2);
    const [approveBtn, denyBtn] = actionsEl?.actions ?? [];
    expect(approveBtn?.text.content).toBe('Approve');
    expect(approveBtn?.value).toMatchObject({
      action: 'approve',
      action_id: '3f9a2c7b',
      conversation_id: 'oc_chat',
    });
    expect(denyBtn?.text.content).toBe('Deny');
    expect(denyBtn?.value).toMatchObject({
      action: 'deny',
      action_id: '3f9a2c7b',
    });
  });

  it('footer note mentions ttl + text-fallback instructions', () => {
    const card = sample({ ttlMinutes: 5 }) as {
      elements: Array<{ tag: string; elements?: Array<{ content: string }> }>;
    };
    const note = card.elements.find((e) => e.tag === 'note');
    const text = note?.elements?.[0]?.content ?? '';
    expect(text).toContain('3f9a2c7b');
    expect(text).toMatch(/5 min/);
    expect(text).toMatch(/\/approve 3f9a2c7b/);
  });

  it('declares update_multi=true so card.action.trigger can replace it inline', () => {
    const card = sample() as { config: { update_multi?: boolean } };
    expect(card.config.update_multi).toBe(true);
  });
});

describe('buildResolvedCard', () => {
  const baseParams = {
    toolName: 'bash',
    actionId: '3f9a2c7b',
    actorOpenId: 'ou_clicker',
    decidedAtMs: Date.parse('2026-05-30T01:23:45Z'),
  };

  it('approve variant: green header, approved title, no buttons', () => {
    const card = buildResolvedCard({ ...baseParams, decision: 'approve' }) as {
      header: { title: { content: string }; template: string };
      elements: Array<{ tag: string; actions?: unknown }>;
    };
    expect(card.header.template).toBe('green');
    expect(card.header.title.content).toMatch(/Approved/);
    expect(card.header.title.content).toMatch(/bash/);
    expect(card.elements.find((e) => Array.isArray(e.actions))).toBeUndefined();
  });

  it('deny variant: grey header and denied title', () => {
    const card = buildResolvedCard({ ...baseParams, decision: 'deny' }) as {
      header: { title: { content: string }; template: string };
    };
    expect(card.header.template).toBe('grey');
    expect(card.header.title.content).toMatch(/Denied/);
  });

  it('body cites the actor open_id and decision time', () => {
    const card = buildResolvedCard({ ...baseParams, decision: 'approve' }) as {
      elements: Array<{ tag: string; text?: { content: string } }>;
    };
    const body = card.elements.find((e) => e.text);
    const content = body?.text?.content ?? '';
    expect(content).toContain('ou_clicker');
    expect(content).toContain('2026-05-30T01:23:45Z');
  });

  it('keeps update_multi=true for any future re-update', () => {
    const card = buildResolvedCard({ ...baseParams, decision: 'approve' }) as {
      config: { update_multi?: boolean };
    };
    expect(card.config.update_multi).toBe(true);
  });

  it('note carries the action id for ops traceability', () => {
    const card = buildResolvedCard({ ...baseParams, decision: 'approve' }) as {
      elements: Array<{ tag: string; elements?: Array<{ content: string }> }>;
    };
    const note = card.elements.find((e) => e.tag === 'note');
    expect(note?.elements?.[0]?.content).toContain('3f9a2c7b');
  });
});

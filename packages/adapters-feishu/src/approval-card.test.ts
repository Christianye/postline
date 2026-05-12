import { describe, expect, it } from 'vitest';
import { buildApprovalCard } from './index.js';

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
});

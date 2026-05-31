import { describe, expect, it } from 'vitest';
import { buildApprovalCard, buildResolvedCard, formatToolArgsPreview } from './index.js';

describe('buildApprovalCard', () => {
  function sample(overrides: Partial<Parameters<typeof buildApprovalCard>[0]> = {}) {
    return buildApprovalCard({
      conversationId: 'oc_chat',
      actionId: '3f9a2c7b',
      toolName: 'bash',
      args: { command: 'rm -rf /tmp/foo' },
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

  it('truncates very long bash command previews with an explicit suffix', () => {
    const card = sample({ args: { command: 'x'.repeat(600) } }) as {
      elements: Array<{ text?: { content: string } }>;
    };
    const body = card.elements.find((e) => e.text?.content?.includes('xxx'));
    expect(body?.text?.content).toMatch(/chars truncated/);
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

describe('formatToolArgsPreview', () => {
  it('bash: command in fenced code block, cwd + timeout as inline footnotes', () => {
    const out = formatToolArgsPreview('bash', {
      command: 'systemctl restart cc.service',
      cwd: '/home/ubuntu',
      timeout_ms: 30_000,
    });
    expect(out.fields[0]).toMatchObject({
      kind: 'code',
      label: 'Command',
      lang: 'bash',
      value: 'systemctl restart cc.service',
    });
    expect(out.fields).toContainEqual(
      expect.objectContaining({ kind: 'inline', label: 'cwd', value: '`/home/ubuntu`' }),
    );
    expect(out.fields).toContainEqual(
      expect.objectContaining({ kind: 'inline', label: 'timeout', value: '30000ms' }),
    );
  });

  it('bash: omits cwd / timeout when not present', () => {
    const out = formatToolArgsPreview('bash', { command: 'ls' });
    expect(out.fields).toHaveLength(1);
  });

  it('bash: appends explicit truncation suffix on >500-char commands', () => {
    const out = formatToolArgsPreview('bash', { command: 'x'.repeat(700) });
    expect(out.fields[0]?.value).toMatch(/200 chars truncated/);
  });

  it('fs_write: surfaces path, content size, and content snippet', () => {
    const out = formatToolArgsPreview('fs_write', {
      path: '/tmp/foo.txt',
      content: 'hello world',
    });
    expect(out.fields[0]).toMatchObject({ kind: 'inline', label: 'Path', value: '`/tmp/foo.txt`' });
    expect(out.fields).toContainEqual(
      expect.objectContaining({ kind: 'inline', label: 'Size', value: '11 chars' }),
    );
    expect(out.fields.find((f) => f.label === 'Content')?.value).toBe('hello world');
  });

  it('fs_edit: shows path, old_string, and new_string each clamped at 200 chars', () => {
    const out = formatToolArgsPreview('fs_edit', {
      path: '/tmp/x',
      old_string: 'a'.repeat(300),
      new_string: 'b',
    });
    const oldField = out.fields.find((f) => f.label === 'Old');
    expect(oldField?.value).toMatch(/100 chars truncated/);
  });

  it('web_fetch: URL inline, optional accept header inline', () => {
    const out = formatToolArgsPreview('web_fetch', {
      url: 'https://example.com',
      accept: 'application/json',
    });
    expect(out.fields).toContainEqual(
      expect.objectContaining({ label: 'URL', value: '`https://example.com`' }),
    );
    expect(out.fields).toContainEqual(
      expect.objectContaining({ label: 'Accept', value: '`application/json`' }),
    );
  });

  it('feishu_send: target chat_id + text + mentions list', () => {
    const out = formatToolArgsPreview('feishu_send', {
      chat_id: 'oc_team',
      text: 'deploy starting',
      mentions: ['ou_a', 'ou_b'],
    });
    expect(out.fields).toContainEqual(
      expect.objectContaining({ label: 'Target', value: '`oc_team`' }),
    );
    expect(out.fields.find((f) => f.label === 'Text')?.value).toBe('deploy starting');
    expect(out.fields.find((f) => f.label === 'Mentions')?.value).toBe('`ou_a`, `ou_b`');
  });

  it('gh_query / gh_action: prefixes "gh " in the bash code block', () => {
    const out = formatToolArgsPreview('gh_action', { args: 'pr merge 6 --squash' });
    expect(out.fields[0]).toMatchObject({
      kind: 'code',
      label: 'Command',
      lang: 'bash',
      value: 'gh pr merge 6 --squash',
    });
  });

  it('skill_run: skill + script + argv joined as shell-quoted line', () => {
    const out = formatToolArgsPreview('skill_run', {
      skill: 'pdf',
      script: 'extract.py',
      args: ['/tmp/x.pdf', '--ocr'],
      timeout_ms: 60_000,
    });
    expect(out.fields).toContainEqual(expect.objectContaining({ label: 'Skill', value: '`pdf`' }));
    expect(out.fields.find((f) => f.label === 'Argv')?.value).toBe('"/tmp/x.pdf" "--ocr"');
    expect(out.fields).toContainEqual(
      expect.objectContaining({ label: 'timeout', value: '60000ms' }),
    );
  });

  it('unknown tool: falls back to a single fenced JSON block', () => {
    const out = formatToolArgsPreview('mcp_some_server_random_tool', { foo: 1, bar: 'baz' });
    expect(out.fields).toHaveLength(1);
    expect(out.fields[0]).toMatchObject({ kind: 'code', label: 'Args', lang: 'json' });
    expect(out.fields[0]?.value).toMatch(/"foo": 1/);
  });
});

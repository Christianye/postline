import { describe, expect, it } from 'vitest';
import { buildApprovalPrompt, buildResolvedText, parseCallbackData } from './approval.js';

describe('buildApprovalPrompt', () => {
  it('builds two buttons with verb:actionId callback_data', () => {
    const p = buildApprovalPrompt({ actionId: 'a1b2c3d4', toolName: 'bash', ttlMinutes: 10 });
    const row = p.reply_markup.inline_keyboard[0];
    expect(row?.[0]?.callback_data).toBe('approve:a1b2c3d4');
    expect(row?.[1]?.callback_data).toBe('deny:a1b2c3d4');
    expect(p.text).toContain('bash');
    expect(p.text).toContain('/approve a1b2c3d4');
  });

  it('callback_data stays well under Telegram 64-byte cap', () => {
    const p = buildApprovalPrompt({ actionId: '12345678', toolName: 'x', ttlMinutes: 5 });
    for (const row of p.reply_markup.inline_keyboard) {
      for (const btn of row) {
        expect(Buffer.byteLength(btn.callback_data, 'utf8')).toBeLessThanOrEqual(64);
      }
    }
  });
});

describe('parseCallbackData', () => {
  it('parses approve / deny', () => {
    expect(parseCallbackData('approve:a1b2c3d4')).toEqual({
      action: 'approve',
      actionId: 'a1b2c3d4',
    });
    expect(parseCallbackData('deny:zzz')).toEqual({ action: 'deny', actionId: 'zzz' });
  });

  it('rejects malformed / unknown data', () => {
    expect(parseCallbackData(undefined)).toBeNull();
    expect(parseCallbackData('garbage')).toBeNull();
    expect(parseCallbackData('maybe:x')).toBeNull();
  });
});

describe('buildResolvedText', () => {
  it('renders an approved resolution', () => {
    const t = buildResolvedText({
      toolName: 'bash',
      actionId: 'a1b2c3d4',
      decision: 'approve',
      actorId: 42,
    });
    expect(t).toContain('Approved');
    expect(t).toContain('bash');
    expect(t).toContain('42');
  });
});

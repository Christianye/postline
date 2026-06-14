/**
 * Approval UX for Telegram: an inline keyboard with Approve / Deny buttons.
 *
 * Mirrors the feishu approval card semantics (8-char actionId + TTL
 * auto-deny + text `/approve <id>` fallback). On click, Telegram sends a
 * `callback_query` whose `data` we parse back into a decision.
 *
 * `callback_data` is capped at 64 bytes by Telegram; our payload
 * `<verb>:<actionId>` is ~16 bytes — comfortable.
 */

export interface ApprovalKeyboardParams {
  /** 8-char action id — same id the text `/approve <id>` fallback uses. */
  actionId: string;
  /** Tool name shown in the prompt body. */
  toolName: string;
  /** TTL shown in the footer, informational. */
  ttlMinutes: number;
  /** One-line argument preview (already formatted + clipped by the caller). */
  argsPreview?: string;
}

export interface InlineKeyboardMarkup {
  inline_keyboard: Array<Array<{ text: string; callback_data: string }>>;
}

export interface ApprovalPrompt {
  text: string;
  reply_markup: InlineKeyboardMarkup;
}

/** Build the approval prompt text + inline keyboard. */
export function buildApprovalPrompt(params: ApprovalKeyboardParams): ApprovalPrompt {
  const { actionId, toolName, ttlMinutes, argsPreview } = params;
  const lines = [`⚠️ Approval required — \`${toolName}\` (dangerous)`];
  if (argsPreview) lines.push(argsPreview);
  lines.push(
    `id ${actionId} · auto-denies in ${ttlMinutes} min · fallback: /approve ${actionId} or /deny ${actionId}`,
  );
  return {
    text: lines.join('\n'),
    reply_markup: {
      inline_keyboard: [
        [
          { text: '✅ Approve', callback_data: `approve:${actionId}` },
          { text: '❌ Deny', callback_data: `deny:${actionId}` },
        ],
      ],
    },
  };
}

export interface ParsedCallback {
  action: 'approve' | 'deny';
  actionId: string;
}

/**
 * Parse `callback_query.data` back into an approval decision.
 * Returns null for anything that isn't our `<approve|deny>:<id>` shape.
 */
export function parseCallbackData(data: string | undefined): ParsedCallback | null {
  if (!data) return null;
  const m = /^(approve|deny):(\S+)$/.exec(data);
  if (!m || !m[1] || !m[2]) return null;
  return { action: m[1] as 'approve' | 'deny', actionId: m[2] };
}

/** Build the post-decision text replacing the prompt (no buttons). */
export function buildResolvedText(params: {
  toolName: string;
  actionId: string;
  decision: 'approve' | 'deny';
  actorId: number;
}): string {
  const { toolName, actionId, decision, actorId } = params;
  const icon = decision === 'approve' ? '✅' : '❌';
  const verb = decision === 'approve' ? 'Approved' : 'Denied';
  return `${icon} ${verb} — \`${toolName}\`\nby user ${actorId} · id ${actionId} · resolved`;
}

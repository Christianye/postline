/**
 * Approval UX for Slack: a Block Kit message with Approve / Deny buttons.
 *
 * Mirrors the feishu / telegram approval semantics (8-char actionId + TTL
 * auto-deny + text `/approve <id>` fallback). On click, Slack delivers an
 * `interactive` envelope with a `block_actions` payload; we parse the
 * button's `value` (`<verb>:<actionId>`) back into a decision.
 */

export interface ApprovalBlocksParams {
  actionId: string;
  toolName: string;
  ttlMinutes: number;
  argsPreview?: string;
}

export interface SlackBlock {
  type: string;
  [k: string]: unknown;
}

/** Build the Block Kit blocks for an approval prompt. */
export function buildApprovalBlocks(params: ApprovalBlocksParams): SlackBlock[] {
  const { actionId, toolName, ttlMinutes, argsPreview } = params;
  const blocks: SlackBlock[] = [
    {
      type: 'section',
      text: { type: 'mrkdwn', text: `:warning: *Approval required* — \`${toolName}\` (dangerous)` },
    },
  ];
  if (argsPreview) {
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: argsPreview } });
  }
  blocks.push({
    type: 'actions',
    block_id: `approval:${actionId}`,
    elements: [
      {
        type: 'button',
        text: { type: 'plain_text', text: 'Approve' },
        style: 'primary',
        action_id: 'approve',
        value: `approve:${actionId}`,
      },
      {
        type: 'button',
        text: { type: 'plain_text', text: 'Deny' },
        style: 'danger',
        action_id: 'deny',
        value: `deny:${actionId}`,
      },
    ],
  });
  blocks.push({
    type: 'context',
    elements: [
      {
        type: 'mrkdwn',
        text: `id ${actionId} · auto-denies in ${ttlMinutes} min · fallback: /approve ${actionId} or /deny ${actionId}`,
      },
    ],
  });
  return blocks;
}

export interface ParsedAction {
  action: 'approve' | 'deny';
  actionId: string;
  /** Clicker's Slack user id. */
  userId: string;
  /** Channel + message ts so we can update the prompt in place. */
  channel: string;
  ts: string;
}

interface BlockActionsPayload {
  type?: string;
  user?: { id?: string };
  channel?: { id?: string };
  message?: { ts?: string };
  actions?: Array<{ value?: string }>;
}

/** Parse an `interactive` envelope's `block_actions` payload. */
export function parseBlockActions(payload: unknown): ParsedAction | null {
  const p = payload as BlockActionsPayload;
  if (!p || p.type !== 'block_actions') return null;
  const value = p.actions?.[0]?.value;
  const m = value ? /^(approve|deny):(\S+)$/.exec(value) : null;
  if (!m || !m[1] || !m[2]) return null;
  return {
    action: m[1] as 'approve' | 'deny',
    actionId: m[2],
    userId: p.user?.id ?? '',
    channel: p.channel?.id ?? '',
    ts: p.message?.ts ?? '',
  };
}

/** Block Kit blocks for the resolved (post-click) state — no buttons. */
export function buildResolvedBlocks(params: {
  toolName: string;
  actionId: string;
  decision: 'approve' | 'deny';
  actorId: string;
}): SlackBlock[] {
  const { toolName, actionId, decision, actorId } = params;
  const icon = decision === 'approve' ? ':white_check_mark:' : ':x:';
  const verb = decision === 'approve' ? 'Approved' : 'Denied';
  return [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `${icon} *${verb}* — \`${toolName}\`\nby <@${actorId}> · id ${actionId} · resolved`,
      },
    },
  ];
}

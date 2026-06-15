import { randomUUID } from 'node:crypto';
import { type ActionEvent, type SlackChannel, createSlackChannel } from '@postline/adapters-slack';
import { runImBridge } from './im-bridge.js';

/**
 * `postline slack` — Slack (Socket Mode) bridge daemon.
 *
 * Thin wiring over the shared `runImBridge` runner (PR-DB-7): supplies a
 * SlackChannel + slack-specific allowlist + the Block Kit approval flow.
 * Independent bridge process (own doorbell).
 */
export async function runSlack(): Promise<void> {
  await runImBridge<SlackChannel>({
    channelName: 'slack',
    createChannel: (log, cfg) => {
      if (!cfg.slack) {
        process.stderr.write('config.slack is not set; cannot start slack bot.\n');
        return null;
      }
      const appToken = process.env.CC_SLACK_APP_TOKEN ?? cfg.slack.appToken ?? '';
      const botToken = process.env.CC_SLACK_BOT_TOKEN ?? cfg.slack.botToken ?? '';
      if (!appToken || !botToken) {
        process.stderr.write(
          'CC_SLACK_APP_TOKEN + CC_SLACK_BOT_TOKEN env (or config.slack.{appToken,botToken}) must be set.\n',
        );
        return null;
      }
      return createSlackChannel({
        appToken,
        botToken,
        log,
        requireMention: cfg.slack.requireMention ?? true,
        ...(cfg.slack.botUserId ? { botUserId: cfg.slack.botUserId } : {}),
        ...(cfg.slack.apiBase ? { apiBase: cfg.slack.apiBase } : {}),
      });
    },
    extraAllowlist: (cfg) => cfg.slack?.allowlist ?? [],
    wireApproval: ({ channel, pending, allowlist, log }) => {
      channel.onAction(async (evt: ActionEvent) => {
        if (!allowlist.has(evt.userId)) return;
        const entry = pending.get(evt.actionId);
        if (!entry) return;
        if (evt.action === 'approve') pending.approve(evt.actionId);
        else pending.deny(evt.actionId);
        await channel.resolveApproval({
          channel: evt.channel,
          ts: evt.ts,
          toolName: entry.tool,
          actionId: evt.actionId,
          decision: evt.action,
          actorId: evt.userId,
        });
      });
      return async (tool, args, ctx) => {
        const actionId = randomUUID().slice(0, 8);
        try {
          await channel.sendApproval({
            conversationId: ctx.conversationId,
            actionId,
            toolName: tool.name,
            ttlMinutes: 5,
            argsPreview: `args: ${JSON.stringify(args).slice(0, 300)}`,
          });
        } catch (e) {
          log.warn({ err: (e as Error).message, actionId }, 'slack_approval_send_failed');
          return false;
        }
        return pending.create({
          id: actionId,
          tool: tool.name,
          args,
          userId: ctx.userId,
          conversationId: ctx.conversationId,
          ttlMs: 5 * 60_000,
        });
      };
    },
  });
}

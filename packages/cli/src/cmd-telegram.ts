import { randomUUID } from 'node:crypto';
import {
  type CallbackEvent,
  type TelegramChannel,
  createTelegramChannel,
} from '@postline/adapters-telegram';
import { authorizeApproval, runImBridge } from './im-bridge.js';

/**
 * `postline telegram` — Telegram bridge daemon.
 *
 * Thin wiring over the shared `runImBridge` runner (PR-DB-7): supplies a
 * TelegramChannel + telegram-specific allowlist + the inline-keyboard
 * approval flow. Independent bridge process (own doorbell). Run feishu and
 * telegram as separate processes if you want both.
 */
export async function runTelegram(): Promise<void> {
  await runImBridge<TelegramChannel>({
    channelName: 'telegram',
    createChannel: (log, cfg) => {
      if (!cfg.telegram) {
        process.stderr.write('config.telegram is not set; cannot start telegram bot.\n');
        return null;
      }
      const botToken = process.env.CC_TELEGRAM_BOT_TOKEN ?? cfg.telegram.botToken ?? '';
      if (!botToken) {
        process.stderr.write(
          'CC_TELEGRAM_BOT_TOKEN env (or config.telegram.botToken) must be set.\n',
        );
        return null;
      }
      return createTelegramChannel({
        botToken,
        log,
        requireMention: cfg.telegram.requireMention ?? true,
        ...(cfg.telegram.apiBase ? { apiBase: cfg.telegram.apiBase } : {}),
      });
    },
    extraAllowlist: (cfg) => cfg.telegram?.allowlist ?? [],
    wireApproval: ({ channel, pending, allowlist, log, cfg }) => {
      const requesterOnly = cfg.telegram?.approval?.requesterOnly ?? true;
      const admins = new Set((cfg.telegram?.approval?.admins ?? []).map(String));
      channel.onCallback(async (evt: CallbackEvent) => {
        if (!allowlist.has(String(evt.userId))) return;
        const entry = pending.get(evt.actionId);
        if (!entry) return;
        if (
          !authorizeApproval({
            clickerId: String(evt.userId),
            requesterUserId: entry.userId,
            requesterOnly,
            admins,
            log,
            actionId: evt.actionId,
          })
        )
          return;
        if (evt.action === 'approve') pending.approve(evt.actionId);
        else pending.deny(evt.actionId);
        await channel.resolveApproval({
          callbackQueryId: evt.callbackQueryId,
          chatId: evt.chatId,
          messageId: evt.messageId,
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
          log.warn({ err: (e as Error).message, actionId }, 'telegram_approval_send_failed');
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

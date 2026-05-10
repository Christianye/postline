import { randomUUID } from 'node:crypto';
import * as Lark from '@larksuiteoapi/node-sdk';
import type { Tool, ToolResult } from '@postline/core';

export interface FeishuSendOptions {
  appId: string;
  appSecret: string;
  /** `Lark.Domain.Feishu` (cn, default) or `Lark.Domain.Lark` (global). */
  domain?: string;
  /**
   * Hard allowlist of chat_ids / open_ids this tool may send to. Empty =
   * tool refuses all sends. Prevents prompt-injected bots from spamming
   * arbitrary groups the bot was added to.
   */
  sendAllowlist: readonly string[];
  /** Messages per minute per target. Default 5. */
  ratePerMin?: number;
  /** Max text length in chars. Default 4500 (matches feishu message ceiling). */
  maxChars?: number;
}

/**
 * Hard length used when caller didn't override. feishu's `text` msg type tops
 * out around 5000 chars; 4500 leaves slack for @mention prefixes.
 */
const DEFAULT_MAX_CHARS = 4500;

export function createFeishuSendTool(opts: FeishuSendOptions): Tool {
  if (!opts.appId || !opts.appSecret) {
    throw new Error('feishu_send requires appId + appSecret');
  }
  const allowlist = new Set(opts.sendAllowlist);
  const ratePerMin = opts.ratePerMin ?? 5;
  const maxChars = opts.maxChars ?? DEFAULT_MAX_CHARS;
  const client = new Lark.Client({
    appId: opts.appId,
    appSecret: opts.appSecret,
    domain: opts.domain ?? Lark.Domain.Feishu,
    loggerLevel: Lark.LoggerLevel.warn,
  });

  // In-memory rate limiter: target -> queue of send timestamps (ms). Old
  // entries are GC'd on each call so the map doesn't grow unbounded.
  const recent = new Map<string, number[]>();
  const checkRate = (target: string): void => {
    const now = Date.now();
    const cutoff = now - 60_000;
    const q = (recent.get(target) ?? []).filter((t) => t >= cutoff);
    if (q.length >= ratePerMin) {
      throw new Error(
        `feishu_send rate limit: ${ratePerMin} messages/minute/target; ${target} already at ${q.length}`,
      );
    }
    q.push(now);
    recent.set(target, q);
  };

  return {
    name: 'feishu_send',
    description:
      'Send a text message to a feishu chat or user. target must be on the configured sendAllowlist. Use for proactive notifications (daily reports, alerts, follow-ups) — NOT for replying to the current conversation (the framework does that automatically). mentions is a list of open_ids to @-mention at the start of the message.',
    risk: 'write',
    inputSchema: {
      type: 'object',
      properties: {
        chat_id: {
          type: 'string',
          description:
            'Target. `oc_...` = group chat_id; `ou_...` = user open_id (DM). Must be on sendAllowlist.',
        },
        text: {
          type: 'string',
          description: `Message text, max ${maxChars} chars. No auto-splitting — keep it short or summarise first.`,
        },
        mentions: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Optional list of open_ids to @-mention. Prepended to the message as `<at user_id="ou_xxx"></at>`.',
        },
      },
      required: ['chat_id', 'text'],
      additionalProperties: false,
    },

    async run(args): Promise<ToolResult> {
      const target = typeof args.chat_id === 'string' ? args.chat_id : '';
      const text = typeof args.text === 'string' ? args.text : '';
      const mentions = Array.isArray(args.mentions)
        ? args.mentions.filter((m): m is string => typeof m === 'string')
        : [];

      if (!target) return { content: 'ERROR: chat_id required', isError: true };
      if (!text) return { content: 'ERROR: text required', isError: true };

      if (!allowlist.has(target)) {
        return {
          content: `ERROR: target ${target} is not on feishu.sendAllowlist. Ask the operator to add it to the config if this is intentional.`,
          isError: true,
        };
      }

      if (text.length > maxChars) {
        return {
          content: `ERROR: text is ${text.length} chars, max ${maxChars}. Shorten or summarise before sending.`,
          isError: true,
        };
      }

      try {
        checkRate(target);
      } catch (e) {
        return { content: `ERROR: ${(e as Error).message}`, isError: true };
      }

      // open_id (ou_) → DM; chat_id (oc_) → group. Anything else we treat as
      // chat_id so operator-supplied custom ids still flow through.
      const receiveIdType: 'open_id' | 'chat_id' = target.startsWith('ou_') ? 'open_id' : 'chat_id';

      const mentionPrefix = mentions.map((id) => `<at user_id="${id}"></at>`).join('');
      const body = mentionPrefix + (mentionPrefix ? ' ' : '') + text;

      try {
        const resp = await client.im.v1.message.create({
          params: { receive_id_type: receiveIdType },
          data: {
            receive_id: target,
            content: JSON.stringify({ text: body }),
            msg_type: 'text',
            uuid: randomUUID().slice(0, 50),
          },
        });
        // SDK returns { data: { message_id, ... } } on success.
        const msgId =
          (resp as unknown as { data?: { message_id?: string } })?.data?.message_id ?? 'unknown';
        return {
          content: `sent to ${target} (msg_id=${msgId})`,
          meta: { target, messageId: msgId, bytes: body.length },
        };
      } catch (e) {
        return {
          content: `ERROR: feishu_send failed: ${(e as Error).message}`,
          isError: true,
        };
      }
    },
  };
}

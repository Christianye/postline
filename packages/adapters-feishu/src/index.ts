import { randomUUID } from 'node:crypto';
import * as Lark from '@larksuiteoapi/node-sdk';
import type { Channel, InboundMessage, Logger, OutboundMessage } from '@postline/core';
import { EventDedup } from './dedup.js';
import { type ReceiveV1Event, parseReceiveV1, stripMentionPrefix } from './parse.js';
import { splitForFeishu } from './split.js';

export type { ParsedMessage, ReceiveV1Event } from './parse.js';
export { EventDedup } from './dedup.js';
export { parseReceiveV1, stripMentionPrefix } from './parse.js';
export { splitForFeishu } from './split.js';

export interface FeishuChannelOptions {
  appId: string;
  appSecret: string;
  /**
   * Bot's own open_id. Used to detect @-mentions. If unset we'll auto-fetch it once.
   */
  botOpenId?: string;
  /** `Lark.Domain.Feishu` (cn) or `Lark.Domain.Lark` (global). Default Feishu. */
  domain?: string;
  log: Logger;
  /**
   * If true, only respond to messages that @-mention the bot or are in 1:1 chats.
   * Default true. (Set false for testing; you'll still drop bot-authored messages.)
   */
  requireMention?: boolean;
}

/**
 * Extends the core `Channel` with Feishu-specific helpers the turn runner
 * needs but shouldn't be part of the cross-channel abstraction.
 */
export interface FeishuChannel extends Channel {
  /** Download an image from a received message. Returns raw bytes + best-guess mime. */
  downloadImage(messageId: string, imageKey: string): Promise<DownloadedImage>;
  /**
   * Send a text message and return the feishu message_id. Used by the
   * streaming path to capture the seed message id for subsequent edits.
   */
  sendText(params: { conversationId: string; text: string }): Promise<{ messageId: string }>;
  /**
   * Edit a previously-sent text message. Feishu's im/v1/messages PATCH only
   * supports text + post types; cards use their own update API.
   */
  editText(messageId: string, text: string): Promise<void>;
  /**
   * Post an interactive approval card to a chat. The card carries two buttons
   * (approve / deny) whose click produces an `im.message.card_action.trigger_v1`
   * event that arrives via `onCardAction`. Falls back cleanly if the feishu
   * app scope for interactive events isn't granted: the text `/approve <id>`
   * path still works because the card body includes the id.
   */
  sendApprovalCard(params: ApprovalCardParams): Promise<void>;
  /**
   * Register a handler for card button clicks. Returns an unsubscribe fn.
   * Must be called AFTER `listen()` has started the event dispatcher.
   */
  onCardAction(
    cb: (
      evt: CardActionEvent,
    ) => CardActionResponse | undefined | Promise<CardActionResponse | undefined>,
  ): () => void;
}

export interface ApprovalCardParams {
  conversationId: string;
  /** 8-char id used by the existing text /approve path — same id as the card. */
  actionId: string;
  /** Tool name to display in the card header. */
  toolName: string;
  /** JSON-preview of args to show in the card body (caller-truncated). */
  argsPreview: string;
  /** TTL shown in the footer, purely informational. */
  ttlMinutes: number;
}

export interface CardActionEvent {
  /** 'approve' | 'deny' — our own `value.action` payload. */
  action: string;
  /** 8-char action id round-tripped via card value. */
  actionId: string;
  /** Clicker's open_id. */
  userId: string;
  /** Chat the card was posted in. */
  conversationId: string;
}

export interface CardActionResponse {
  /** Optional toast text shown on the clicker's screen. */
  toast?: { type: 'success' | 'info' | 'error'; content: string };
}

export interface DownloadedImage {
  bytes: Buffer;
  mimeType: 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';
}

/**
 * Feishu (Lark) long-connection channel.
 *
 * Security & behavioural rules (not config):
 * - only `sender_type === 'user'` inbound messages are forwarded upstream
 * - in group chats, the bot must be @-mentioned (unless requireMention=false)
 * - event_id is deduped across reconnects
 */
export function createFeishuChannel(opts: FeishuChannelOptions): FeishuChannel {
  const log = opts.log.child({ channel: 'feishu' });
  const httpClient = new Lark.Client({
    appId: opts.appId,
    appSecret: opts.appSecret,
    domain: opts.domain ?? Lark.Domain.Feishu,
    loggerLevel: Lark.LoggerLevel.warn,
  });
  const wsClient = new Lark.WSClient({
    appId: opts.appId,
    appSecret: opts.appSecret,
    domain: opts.domain ?? Lark.Domain.Feishu,
    loggerLevel: Lark.LoggerLevel.warn,
    autoReconnect: true,
  });

  const dedup = new EventDedup();
  let botOpenId = opts.botOpenId ?? '';
  const requireMention = opts.requireMention ?? true;
  let stopped = false;
  const cardActionCallbacks = new Set<
    (
      evt: CardActionEvent,
    ) => CardActionResponse | undefined | Promise<CardActionResponse | undefined>
  >();

  return {
    name: 'feishu',
    listen(onMessage) {
      const dispatcher = new Lark.EventDispatcher({}).register({
        'card.action.trigger': async (rawEvent: unknown) => {
          // Interactive card button click. The payload shape differs slightly
          // between feishu SDK versions; we extract defensively.
          const payload = rawEvent as {
            action?: { value?: unknown; tag?: string };
            operator?: { open_id?: string; user_id?: string };
            token?: string;
            open_chat_id?: string;
            open_message_id?: string;
            event?: {
              action?: { value?: unknown };
              operator?: { open_id?: string };
              open_chat_id?: string;
            };
          };
          const action = payload.action ?? payload.event?.action ?? {};
          const value = (action.value ?? {}) as {
            action?: string;
            action_id?: string;
            conversation_id?: string;
          };
          const clickerId = payload.operator?.open_id ?? payload.event?.operator?.open_id ?? '';
          const chatId =
            payload.open_chat_id ?? payload.event?.open_chat_id ?? value.conversation_id ?? '';
          if (!value.action || !value.action_id || !clickerId || !chatId) {
            log.warn(
              { payload: JSON.stringify(payload).slice(0, 300) },
              'feishu_card_action_malformed',
            );
            return {};
          }
          const evt: CardActionEvent = {
            action: value.action,
            actionId: value.action_id,
            userId: clickerId,
            conversationId: chatId,
          };
          for (const cb of cardActionCallbacks) {
            try {
              const r = await cb(evt);
              if (r?.toast) {
                return { toast: r.toast };
              }
            } catch (e) {
              log.error({ err: (e as Error).message }, 'feishu_card_action_cb_error');
            }
          }
          return {};
        },
        'im.message.receive_v1': async (rawEvent: unknown) => {
          const event = rawEvent as ReceiveV1Event & {
            event_id?: string;
            __raw?: { header?: { event_id?: string } };
          };
          // event_id typically lives in the outer envelope; some SDK versions attach it here.
          const eventId =
            (event as { event_id?: string }).event_id ??
            event.__raw?.header?.event_id ??
            `${event.message?.message_id}-${Date.now()}`;
          if (dedup.has(eventId)) {
            log.debug({ eventId }, 'feishu_event_dedup_skip');
            return;
          }
          dedup.add(eventId);

          const parsed = parseReceiveV1(event);
          if (!parsed) return;
          if (parsed.senderType !== 'user') {
            log.debug({ senderType: parsed.senderType }, 'feishu_non_user_skip');
            return;
          }
          if (
            requireMention &&
            parsed.chatType === 'group' &&
            (!botOpenId || !parsed.mentionedOpenIds.includes(botOpenId))
          ) {
            return;
          }

          const body = stripMentionPrefix(parsed.text);
          const inbound: InboundMessage = {
            id: randomUUID(),
            userId: parsed.senderOpenId,
            conversationId: parsed.chatId,
            text: body,
            receivedAt: Date.now(),
            meta: {
              messageId: parsed.messageId,
              chatType: parsed.chatType,
              messageType: parsed.messageType,
              imageKeys: parsed.imageKeys,
            },
          };

          try {
            await onMessage(inbound);
          } catch (e) {
            log.error({ err: (e as Error).message, turn: inbound.id }, 'feishu_handler_error');
          }
        },
      });

      (async () => {
        if (!botOpenId) {
          try {
            // best-effort: fetch the bot's open_id so we can match @-mentions
            const info = (await httpClient.request({
              method: 'GET',
              url: '/open-apis/bot/v3/info',
            })) as { bot?: { open_id?: string }; data?: { bot?: { open_id?: string } } };
            const open = info?.bot?.open_id ?? info?.data?.bot?.open_id;
            if (open) {
              botOpenId = open;
              log.info({ botOpenId }, 'feishu_bot_identified');
            } else {
              log.warn({ resp: JSON.stringify(info).slice(0, 300) }, 'feishu_bot_open_id_unknown');
            }
          } catch (e) {
            log.warn({ err: (e as Error).message }, 'feishu_bot_info_failed');
          }
        }
        try {
          await wsClient.start({ eventDispatcher: dispatcher });
          log.info({}, 'feishu_ws_started');
        } catch (e) {
          log.error({ err: (e as Error).message }, 'feishu_ws_start_failed');
        }
      })();

      return async () => {
        stopped = true;
        try {
          // WSClient in @larksuiteoapi/node-sdk >=1.48 exposes `close()`, not `stop()`.
          const anyWs = wsClient as unknown as {
            close?: () => void | Promise<void>;
            stop?: () => void | Promise<void>;
          };
          if (typeof anyWs.close === 'function') await Promise.resolve(anyWs.close());
          else if (typeof anyWs.stop === 'function') await Promise.resolve(anyWs.stop());
        } catch (e) {
          log.warn({ err: (e as Error).message }, 'feishu_ws_stop_error');
        }
      };
    },

    async send(msg: OutboundMessage) {
      if (stopped) throw new Error('feishu channel stopped');
      const replyToId = (msg.meta?.replyToMessageId as string | undefined) ?? undefined;
      const parts = splitForFeishu(msg.text);
      for (let i = 0; i < parts.length; i++) {
        const content = JSON.stringify({ text: parts[i] });
        if (replyToId && i === 0) {
          // First chunk threaded as a reply; subsequent chunks go as new messages
          // to avoid spamming the same reply target.
          await httpClient.im.v1.message.reply({
            path: { message_id: replyToId },
            data: {
              content,
              msg_type: 'text',
              uuid: randomUUID().slice(0, 50),
            },
          });
        } else {
          await httpClient.im.v1.message.create({
            params: { receive_id_type: 'chat_id' },
            data: {
              receive_id: msg.conversationId,
              content,
              msg_type: 'text',
              uuid: randomUUID().slice(0, 50),
            },
          });
        }
        if (i < parts.length - 1) {
          // Pace chunks below feishu's 5 req/s per-chat rate limit.
          await new Promise((r) => setTimeout(r, 300));
        }
      }
    },

    async health() {
      try {
        // Bot self-info endpoint confirms auth & connectivity.
        await httpClient.request({ method: 'GET', url: '/open-apis/bot/v3/info' });
        return { ok: true };
      } catch (e) {
        return { ok: false, detail: (e as Error).message };
      }
    },

    async sendText(params) {
      if (stopped) throw new Error('feishu channel stopped');
      const resp = (await httpClient.im.v1.message.create({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: params.conversationId,
          content: JSON.stringify({ text: params.text }),
          msg_type: 'text',
          uuid: randomUUID().slice(0, 50),
        },
      })) as unknown as { data?: { message_id?: string }; message_id?: string };
      const messageId = resp.data?.message_id ?? resp.message_id ?? '';
      if (!messageId) throw new Error('feishu sendText: no message_id in response');
      return { messageId };
    },

    async editText(messageId, text) {
      if (stopped) throw new Error('feishu channel stopped');
      await httpClient.im.v1.message.update({
        path: { message_id: messageId },
        data: {
          msg_type: 'text',
          content: JSON.stringify({ text }),
        },
      });
    },

    async sendApprovalCard(params: ApprovalCardParams): Promise<void> {
      if (stopped) throw new Error('feishu channel stopped');
      const card = buildApprovalCard(params);
      await httpClient.im.v1.message.create({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: params.conversationId,
          content: JSON.stringify(card),
          msg_type: 'interactive',
          uuid: randomUUID().slice(0, 50),
        },
      });
    },

    onCardAction(cb) {
      cardActionCallbacks.add(cb);
      return () => {
        cardActionCallbacks.delete(cb);
      };
    },

    async downloadImage(messageId, imageKey): Promise<DownloadedImage> {
      const resp = (await httpClient.im.v1.messageResource.get({
        path: { message_id: messageId, file_key: imageKey },
        params: { type: 'image' },
      })) as unknown as {
        getReadableStream: () => NodeJS.ReadableStream;
        headers?: Record<string, string>;
      };
      const stream = resp.getReadableStream();
      const chunks: Buffer[] = [];
      for await (const chunk of stream as AsyncIterable<Buffer>) {
        chunks.push(chunk);
      }
      const bytes = Buffer.concat(chunks);
      const rawMime = (resp.headers?.['content-type'] ?? '').split(';')[0]?.trim() ?? '';
      const mimeType = normalizeImageMime(rawMime, bytes);
      return { bytes, mimeType };
    },
  };
}

function normalizeImageMime(
  rawMime: string,
  bytes: Buffer,
): 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp' {
  const allowed = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'] as const;
  if ((allowed as readonly string[]).includes(rawMime)) {
    return rawMime as (typeof allowed)[number];
  }
  // Sniff magic bytes as a fallback — Feishu's content-type header is sometimes missing.
  if (bytes.length >= 4) {
    if (bytes[0] === 0xff && bytes[1] === 0xd8) return 'image/jpeg';
    if (bytes[0] === 0x89 && bytes[1] === 0x50) return 'image/png';
    if (bytes[0] === 0x47 && bytes[1] === 0x49) return 'image/gif';
    if (bytes.length >= 12 && bytes.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  }
  // Default to jpeg — most feishu screenshots are jpeg.
  return 'image/jpeg';
}

/**
 * Build a Feishu interactive card payload for the approval prompt. Uses the
 * stable legacy message-card schema so the card renders on desktop + mobile
 * across widely-deployed feishu client versions.
 *
 * On button click Feishu sends `card.action.trigger` with
 * `action.value === { action: 'approve' | 'deny', action_id, conversation_id }`.
 */
export function buildApprovalCard(params: ApprovalCardParams): Record<string, unknown> {
  const { actionId, toolName, argsPreview, ttlMinutes, conversationId } = params;
  const clamped = argsPreview.length > 500 ? `${argsPreview.slice(0, 500)}…` : argsPreview;
  return {
    config: { wide_screen_mode: true },
    header: {
      template: 'red',
      title: { tag: 'plain_text', content: `🦞 Approval required — ${toolName}` },
    },
    elements: [
      {
        tag: 'div',
        text: {
          tag: 'lark_md',
          content: `**Tool**: \`${toolName}\` (dangerous)\n**Args**:\n\`\`\`${clamped}\`\`\``,
        },
      },
      {
        tag: 'action',
        actions: [
          {
            tag: 'button',
            text: { tag: 'plain_text', content: 'Approve' },
            type: 'primary',
            value: { action: 'approve', action_id: actionId, conversation_id: conversationId },
          },
          {
            tag: 'button',
            text: { tag: 'plain_text', content: 'Deny' },
            type: 'danger',
            value: { action: 'deny', action_id: actionId, conversation_id: conversationId },
          },
        ],
      },
      {
        tag: 'note',
        elements: [
          {
            tag: 'plain_text',
            content: `id ${actionId} · auto-denies in ${ttlMinutes} min · fallback: reply /approve ${actionId} or /deny ${actionId}`,
          },
        ],
      },
    ],
  };
}

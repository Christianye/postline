import type { Channel, InboundMessage, Logger, OutboundMessage } from '@postline/core';
import {
  type ApprovalKeyboardParams,
  type ParsedCallback,
  buildApprovalPrompt,
  buildResolvedText,
  parseCallbackData,
} from './approval.js';
import { type TelegramUpdate, parseMessageUpdate, stripBotMention } from './parse.js';
import { type TelegramApiResponse, runPollLoop } from './poll.js';
import { splitForTelegram } from './split.js';

export { splitForTelegram } from './split.js';
export {
  parseMessageUpdate,
  stripBotMention,
  type TelegramUpdate,
  type TelegramMessage,
  type ParsedTelegramMessage,
} from './parse.js';
export {
  buildApprovalPrompt,
  parseCallbackData,
  buildResolvedText,
  type ParsedCallback,
  type InlineKeyboardMarkup,
} from './approval.js';
export { runPollLoop, type PollLoopOptions } from './poll.js';

export interface TelegramChannelOptions {
  /** Bot token from @BotFather. */
  botToken: string;
  /** API base. Default `https://api.telegram.org`. Injectable for tests. */
  apiBase?: string;
  log: Logger;
  /**
   * If true, in group chats only respond to messages that @-mention the bot
   * or are `/commands`. Private chats always pass. Default true.
   */
  requireMention?: boolean;
  /** Long-poll timeout in seconds. Default 30. */
  longPollTimeoutSeconds?: number;
  /** fetch impl; defaults to global fetch. */
  fetcher?: typeof globalThis.fetch;
}

export interface CallbackEvent {
  /** 'approve' | 'deny' — parsed from callback_data. */
  action: 'approve' | 'deny';
  /** 8-char action id round-tripped via callback_data. */
  actionId: string;
  /** Clicker's numeric Telegram user id. */
  userId: number;
  /** Chat the inline keyboard was posted in. */
  chatId: number;
  /** The message carrying the keyboard (so we can edit it on resolve). */
  messageId: number;
  /** callback_query id, needed to answer the toast. */
  callbackQueryId: string;
}

export interface DownloadedPhoto {
  bytes: Buffer;
  mimeType: 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';
}

/**
 * Telegram channel extending the core `Channel` with the methods the turn
 * runner needs — the same extended surface FeishuChannel exposes, so a
 * shared turn-runner (future extraction) can treat them uniformly.
 */
export interface TelegramChannel extends Channel {
  sendText(params: { conversationId: string; text: string }): Promise<{ messageId: string }>;
  editText(messageId: string, text: string, conversationId: string): Promise<void>;
  sendApproval(params: {
    conversationId: string;
    actionId: string;
    toolName: string;
    ttlMinutes: number;
    argsPreview?: string;
  }): Promise<{ messageId: string }>;
  /** Answer a callback query's toast + edit the keyboard message to resolved. */
  resolveApproval(params: {
    callbackQueryId: string;
    chatId: number;
    messageId: number;
    toolName: string;
    actionId: string;
    decision: 'approve' | 'deny';
    actorId: number;
  }): Promise<void>;
  onCallback(cb: (evt: CallbackEvent) => void | Promise<void>): () => void;
  downloadPhoto(fileId: string): Promise<DownloadedPhoto>;
}

/**
 * Telegram (Bot API) channel — getUpdates long-poll, no inbound port.
 *
 * Security & behavioural rules (not config):
 * - only non-bot senders are forwarded upstream
 * - in group chats, the bot must be @-mentioned / `/command`-ed
 *   (unless requireMention=false)
 * - update_id offset acks updates so reconnects don't reprocess
 */
export function createTelegramChannel(opts: TelegramChannelOptions): TelegramChannel {
  const log = opts.log.child({ channel: 'telegram' });
  const apiBase = opts.apiBase ?? 'https://api.telegram.org';
  const fetcher = opts.fetcher ?? globalThis.fetch;
  const requireMention = opts.requireMention ?? true;
  let botUsername = '';
  let stopped = false;
  const callbackCallbacks = new Set<(evt: CallbackEvent) => void | Promise<void>>();

  async function api<T>(method: string, params: Record<string, unknown>): Promise<T> {
    const res = await fetcher(`${apiBase}/bot${opts.botToken}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(params),
    });
    const json = (await res.json()) as TelegramApiResponse<T>;
    if (!json.ok) {
      throw new Error(`telegram ${method} failed: ${json.error_code} ${json.description ?? ''}`);
    }
    return json.result as T;
  }

  return {
    name: 'telegram',

    listen(onMessage) {
      (async () => {
        try {
          const me = await api<{ username?: string }>('getMe', {});
          botUsername = me.username ?? '';
          log.info({ botUsername }, 'telegram_bot_identified');
        } catch (e) {
          log.warn({ err: (e as Error).message }, 'telegram_getme_failed');
        }
        await runPollLoop({
          token: opts.botToken,
          apiBase,
          fetcher,
          ...(opts.longPollTimeoutSeconds !== undefined
            ? { timeoutSeconds: opts.longPollTimeoutSeconds }
            : {}),
          running: () => !stopped,
          onError: (err, retryMs) => log.warn({ err: err.message, retryMs }, 'telegram_poll_error'),
          onUpdate: async (u: TelegramUpdate) => {
            if (u.callback_query) {
              await dispatchCallback(u);
              return;
            }
            const parsed = parseMessageUpdate(u, botUsername);
            if (!parsed) return;
            if (parsed.isBot) return; // never react to other bots
            if (requireMention && parsed.chatType === 'group' && !parsed.mentionsBot) return;

            const body = stripBotMention(parsed.text, botUsername);
            const inbound: InboundMessage = {
              id: `tg_${u.update_id}`,
              userId: String(parsed.senderId),
              conversationId: String(parsed.chatId),
              text: body,
              receivedAt: Date.now(),
              meta: {
                messageId: parsed.messageId,
                chatType: parsed.chatType,
                username: parsed.senderUsername,
                ...(parsed.photoFileId ? { photoFileId: parsed.photoFileId } : {}),
              },
            };
            try {
              await onMessage(inbound);
            } catch (e) {
              log.error({ err: (e as Error).message, turn: inbound.id }, 'telegram_handler_error');
            }
          },
        });
      })();

      return async () => {
        stopped = true;
      };
    },

    async send(msg: OutboundMessage) {
      if (stopped) throw new Error('telegram channel stopped');
      const parts = splitForTelegram(msg.text);
      for (let i = 0; i < parts.length; i++) {
        await api('sendMessage', { chat_id: msg.conversationId, text: parts[i] });
        if (i < parts.length - 1) await new Promise((r) => setTimeout(r, 350));
      }
    },

    async health() {
      try {
        await api('getMe', {});
        return { ok: true };
      } catch (e) {
        return { ok: false, detail: (e as Error).message };
      }
    },

    async sendText(params) {
      if (stopped) throw new Error('telegram channel stopped');
      const m = await api<{ message_id: number }>('sendMessage', {
        chat_id: params.conversationId,
        text: params.text,
      });
      return { messageId: String(m.message_id) };
    },

    async editText(messageId, text, conversationId) {
      if (stopped) throw new Error('telegram channel stopped');
      await api('editMessageText', {
        chat_id: conversationId,
        message_id: Number(messageId),
        text,
      });
    },

    async sendApproval(params) {
      if (stopped) throw new Error('telegram channel stopped');
      const prompt = buildApprovalPrompt(params as ApprovalKeyboardParams);
      const m = await api<{ message_id: number }>('sendMessage', {
        chat_id: params.conversationId,
        text: prompt.text,
        reply_markup: prompt.reply_markup,
      });
      return { messageId: String(m.message_id) };
    },

    async resolveApproval(params) {
      if (stopped) throw new Error('telegram channel stopped');
      // Toast first (best-effort), then swap the message to resolved state.
      try {
        await api('answerCallbackQuery', {
          callback_query_id: params.callbackQueryId,
          text: params.decision === 'approve' ? 'Approved' : 'Denied',
        });
      } catch (e) {
        log.warn({ err: (e as Error).message }, 'telegram_answer_callback_failed');
      }
      await api('editMessageText', {
        chat_id: params.chatId,
        message_id: params.messageId,
        text: buildResolvedText({
          toolName: params.toolName,
          actionId: params.actionId,
          decision: params.decision,
          actorId: params.actorId,
        }),
      });
    },

    onCallback(cb) {
      callbackCallbacks.add(cb);
      return () => {
        callbackCallbacks.delete(cb);
      };
    },

    async downloadPhoto(fileId): Promise<DownloadedPhoto> {
      const file = await api<{ file_path?: string }>('getFile', { file_id: fileId });
      if (!file.file_path) throw new Error('telegram getFile: no file_path');
      const url = `${apiBase}/file/bot${opts.botToken}/${file.file_path}`;
      const res = await fetcher(url, { method: 'GET' });
      const bytes = Buffer.from(await res.arrayBuffer());
      return { bytes, mimeType: sniffImageMime(file.file_path, bytes) };
    },
  };

  async function dispatchCallback(u: TelegramUpdate): Promise<void> {
    const q = u.callback_query;
    if (!q) return;
    const parsed: ParsedCallback | null = parseCallbackData(q.data);
    if (!parsed || !q.message) return;
    const evt: CallbackEvent = {
      action: parsed.action,
      actionId: parsed.actionId,
      userId: q.from.id,
      chatId: q.message.chat.id,
      messageId: q.message.message_id,
      callbackQueryId: q.id,
    };
    for (const cb of callbackCallbacks) {
      try {
        await cb(evt);
      } catch (e) {
        log.error({ err: (e as Error).message }, 'telegram_callback_cb_error');
      }
    }
  }
}

function sniffImageMime(
  filePath: string,
  bytes: Buffer,
): 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp' {
  const ext = filePath.toLowerCase();
  if (ext.endsWith('.png')) return 'image/png';
  if (ext.endsWith('.gif')) return 'image/gif';
  if (ext.endsWith('.webp')) return 'image/webp';
  if (bytes.length >= 4) {
    if (bytes[0] === 0x89 && bytes[1] === 0x50) return 'image/png';
    if (bytes[0] === 0x47 && bytes[1] === 0x49) return 'image/gif';
    if (bytes.length >= 12 && bytes.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  }
  return 'image/jpeg';
}

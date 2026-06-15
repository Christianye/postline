import type { Channel, InboundMessage, Logger, OutboundMessage } from '@postline/core';
import {
  type ParsedAction,
  buildApprovalBlocks,
  buildResolvedBlocks,
  parseBlockActions,
} from './approval.js';
import {
  type SlackEventCallback,
  type SocketEnvelope,
  parseMessageEvent,
  stripBotMention,
} from './parse.js';
import { type WsLike, runSocketLoop } from './socket.js';
import { splitForSlack } from './split.js';

export { splitForSlack } from './split.js';
export {
  parseMessageEvent,
  stripBotMention,
  type SlackMessageEvent,
  type ParsedSlackMessage,
  type SocketEnvelope,
} from './parse.js';
export {
  buildApprovalBlocks,
  parseBlockActions,
  buildResolvedBlocks,
  type ParsedAction,
  type SlackBlock,
} from './approval.js';
export { runSocketLoop, openConnection, type WsLike, type SocketLoopOptions } from './socket.js';

export interface SlackChannelOptions {
  /** App-level token (`xapp-…`) for Socket Mode. */
  appToken: string;
  /** Bot token (`xoxb-…`) for Web API calls (chat.postMessage, etc.). */
  botToken: string;
  /** Bot user id (`U…`) for mention detection. Auto-fetched if absent. */
  botUserId?: string;
  apiBase?: string;
  log: Logger;
  /** If true, channels require an @mention; DMs always pass. Default true. */
  requireMention?: boolean;
  fetcher?: typeof globalThis.fetch;
  wsFactory?: (url: string) => WsLike;
}

export interface ActionEvent {
  action: 'approve' | 'deny';
  actionId: string;
  userId: string;
  channel: string;
  ts: string;
}

export interface DownloadedFile {
  bytes: Buffer;
  mimeType: string;
}

/**
 * Slack channel extending core `Channel` with the turn-runner surface
 * (same shape Feishu/Telegram expose), so a shared turn-runner treats
 * them uniformly.
 */
export interface SlackChannel extends Channel {
  sendText(params: { conversationId: string; text: string }): Promise<{ messageId: string }>;
  editText(messageId: string, text: string, conversationId: string): Promise<void>;
  sendApproval(params: {
    conversationId: string;
    actionId: string;
    toolName: string;
    ttlMinutes: number;
    argsPreview?: string;
  }): Promise<{ messageId: string }>;
  resolveApproval(params: {
    channel: string;
    ts: string;
    toolName: string;
    actionId: string;
    decision: 'approve' | 'deny';
    actorId: string;
  }): Promise<void>;
  onAction(cb: (evt: ActionEvent) => void | Promise<void>): () => void;
  downloadFile(url: string): Promise<DownloadedFile>;
}

/**
 * Slack (Socket Mode) channel — no inbound port.
 *
 * Security & behavioural rules (not config):
 * - only non-bot user messages are forwarded upstream
 * - in channels, the bot must be @-mentioned (unless requireMention=false)
 * - every events_api / interactive envelope is acked within 3s (socket.ts)
 */
export function createSlackChannel(opts: SlackChannelOptions): SlackChannel {
  const log = opts.log.child({ channel: 'slack' });
  const apiBase = opts.apiBase ?? 'https://slack.com/api';
  const fetcher = opts.fetcher ?? globalThis.fetch;
  const requireMention = opts.requireMention ?? true;
  let botUserId = opts.botUserId ?? '';
  let stopped = false;
  const actionCallbacks = new Set<(evt: ActionEvent) => void | Promise<void>>();

  async function web<T>(method: string, body: Record<string, unknown>): Promise<T> {
    const res = await fetcher(`${apiBase}/${method}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${opts.botToken}`,
        'content-type': 'application/json; charset=utf-8',
      },
      body: JSON.stringify(body),
    });
    const json = (await res.json()) as { ok: boolean; error?: string } & T;
    if (!json.ok) throw new Error(`slack ${method} failed: ${json.error}`);
    return json;
  }

  return {
    name: 'slack',

    listen(onMessage) {
      (async () => {
        if (!botUserId) {
          try {
            const auth = await web<{ user_id?: string }>('auth.test', {});
            botUserId = auth.user_id ?? '';
            log.info({ botUserId }, 'slack_bot_identified');
          } catch (e) {
            log.warn({ err: (e as Error).message }, 'slack_auth_test_failed');
          }
        }
        await runSocketLoop({
          appToken: opts.appToken,
          apiBase,
          fetcher,
          ...(opts.wsFactory ? { wsFactory: opts.wsFactory } : {}),
          running: () => !stopped,
          onError: (err, retryMs) => log.warn({ err: err.message, retryMs }, 'slack_socket_error'),
          onEnvelope: async (env: SocketEnvelope) => {
            if (env.type === 'interactive') {
              const parsed: ParsedAction | null = parseBlockActions(env.payload);
              if (parsed) await dispatchAction(parsed);
              return;
            }
            if (env.type !== 'events_api') return;
            const cb = env.payload as SlackEventCallback;
            const parsed = parseMessageEvent(cb?.event, botUserId);
            if (!parsed) return;
            if (parsed.isBot) return;
            if (requireMention && parsed.channelType === 'channel' && !parsed.mentionsBot) return;

            const body = stripBotMention(parsed.text, botUserId);
            const inbound: InboundMessage = {
              id: `slack_${parsed.channel}_${parsed.ts}`,
              userId: parsed.userId,
              conversationId: parsed.channel,
              text: body,
              receivedAt: Date.now(),
              meta: {
                ts: parsed.ts,
                channelType: parsed.channelType,
                ...(parsed.file
                  ? { fileUrl: parsed.file.url, fileMime: parsed.file.mimeType }
                  : {}),
              },
            };
            try {
              await onMessage(inbound);
            } catch (e) {
              log.error({ err: (e as Error).message, turn: inbound.id }, 'slack_handler_error');
            }
          },
        });
      })();

      return async () => {
        stopped = true;
      };
    },

    async send(msg: OutboundMessage) {
      if (stopped) throw new Error('slack channel stopped');
      const parts = splitForSlack(msg.text);
      for (let i = 0; i < parts.length; i++) {
        await web('chat.postMessage', { channel: msg.conversationId, text: parts[i] });
        if (i < parts.length - 1) await new Promise((r) => setTimeout(r, 300));
      }
    },

    async health() {
      try {
        await web('auth.test', {});
        return { ok: true };
      } catch (e) {
        return { ok: false, detail: (e as Error).message };
      }
    },

    async sendText(params) {
      if (stopped) throw new Error('slack channel stopped');
      const m = await web<{ ts?: string }>('chat.postMessage', {
        channel: params.conversationId,
        text: params.text,
      });
      if (!m.ts) throw new Error('slack sendText: no ts in response');
      return { messageId: m.ts };
    },

    async editText(messageId, text, conversationId) {
      if (stopped) throw new Error('slack channel stopped');
      await web('chat.update', { channel: conversationId, ts: messageId, text });
    },

    async sendApproval(params) {
      if (stopped) throw new Error('slack channel stopped');
      const blocks = buildApprovalBlocks(params);
      const m = await web<{ ts?: string }>('chat.postMessage', {
        channel: params.conversationId,
        text: `Approval required — ${params.toolName}`,
        blocks,
      });
      if (!m.ts) throw new Error('slack sendApproval: no ts');
      return { messageId: m.ts };
    },

    async resolveApproval(params) {
      if (stopped) throw new Error('slack channel stopped');
      await web('chat.update', {
        channel: params.channel,
        ts: params.ts,
        text: `${params.decision === 'approve' ? 'Approved' : 'Denied'} — ${params.toolName}`,
        blocks: buildResolvedBlocks({
          toolName: params.toolName,
          actionId: params.actionId,
          decision: params.decision,
          actorId: params.actorId,
        }),
      });
    },

    onAction(cb) {
      actionCallbacks.add(cb);
      return () => {
        actionCallbacks.delete(cb);
      };
    },

    async downloadFile(url): Promise<DownloadedFile> {
      // Slack private file URLs require the bot token as a bearer header.
      const res = await fetcher(url, {
        method: 'GET',
        headers: { authorization: `Bearer ${opts.botToken}` },
      });
      const bytes = Buffer.from(await res.arrayBuffer());
      const mimeType =
        res.headers.get('content-type')?.split(';')[0]?.trim() || 'application/octet-stream';
      return { bytes, mimeType };
    },
  };

  async function dispatchAction(a: ParsedAction): Promise<void> {
    const evt: ActionEvent = {
      action: a.action,
      actionId: a.actionId,
      userId: a.userId,
      channel: a.channel,
      ts: a.ts,
    };
    for (const cb of actionCallbacks) {
      try {
        await cb(evt);
      } catch (e) {
        log.error({ err: (e as Error).message }, 'slack_action_cb_error');
      }
    }
  }
}

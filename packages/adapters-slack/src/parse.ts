/**
 * Parsing helpers for Slack Socket Mode envelopes + Events API payloads.
 * Pure + unit-tested so we don't need a live Slack connection to validate.
 *
 * Socket Mode delivers WS frames shaped:
 *   { type: 'hello' | 'events_api' | 'interactive' | 'disconnect',
 *     envelope_id?, payload? }
 * Every events_api / interactive frame must be acked within 3s by sending
 * `{ envelope_id }` back over the socket.
 */

export interface SocketEnvelope {
  type: string; // 'hello' | 'events_api' | 'interactive' | 'disconnect'
  envelope_id?: string;
  payload?: unknown;
  /** Slack asks clients to reconnect when true (graceful WS rotation). */
  accepts_response_payload?: boolean;
}

export interface SlackEventCallback {
  type: 'event_callback';
  event?: SlackMessageEvent;
}

export interface SlackMessageEvent {
  type: string; // 'message' | 'app_mention'
  subtype?: string; // 'bot_message', edits, etc.
  user?: string;
  bot_id?: string;
  channel?: string;
  channel_type?: string; // 'im' | 'channel' | 'group' | 'mpim'
  text?: string;
  ts?: string;
  files?: Array<{ id: string; url_private?: string; mimetype?: string; name?: string }>;
}

export interface ParsedSlackMessage {
  channel: string;
  /** 'im' (DM) or 'channel'/'group' (multi-user). */
  channelType: 'im' | 'channel';
  userId: string;
  isBot: boolean;
  text: string;
  ts: string;
  mentionsBot: boolean;
  /** First file's private URL + mime, if the message carries a file. */
  file: { url: string; mimeType: string } | null;
}

/**
 * Parse an Events API message/app_mention event into our shape.
 * `botUserId` (e.g. `U0123`) detects @-mentions of this bot in channels.
 * Returns null for non-message events / bot messages / edits.
 */
export function parseMessageEvent(
  ev: SlackMessageEvent | undefined,
  botUserId: string,
): ParsedSlackMessage | null {
  if (!ev) return null;
  if (ev.type !== 'message' && ev.type !== 'app_mention') return null;
  // Drop message subtypes (edits, joins, bot_message, etc.) — only fresh
  // user messages are forwarded.
  if (ev.subtype) return null;
  if (ev.bot_id) return null;

  const text = (ev.text ?? '').trim();
  const channelType: 'im' | 'channel' = ev.channel_type === 'im' ? 'im' : 'channel';
  const mentionsBot =
    ev.type === 'app_mention' || (botUserId !== '' && text.includes(`<@${botUserId}>`));

  const f = ev.files?.[0];
  const file = f?.url_private && f.mimetype ? { url: f.url_private, mimeType: f.mimetype } : null;

  return {
    channel: ev.channel ?? '',
    channelType,
    userId: ev.user ?? '',
    isBot: false,
    text,
    ts: ev.ts ?? '',
    mentionsBot,
    file,
  };
}

/** Strip a leading `<@BOTID>` mention from the text. */
export function stripBotMention(text: string, botUserId: string): string {
  if (!botUserId) return text.trim();
  return text.replace(new RegExp(`<@${escapeRegExp(botUserId)}>\\s*`, 'g'), '').trim();
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

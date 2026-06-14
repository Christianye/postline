/**
 * Parsing helpers for Telegram Bot API `Update` objects.
 * Pure + unit-tested so we don't need a live bot to validate.
 *
 * We adapt the subset we care about: text messages + photos, in private
 * and group chats. Mention gating in groups keys on a `@botusername`
 * text mention or a `/command` entity (matching the feishu requireMention
 * behaviour); private (1:1) chats always pass.
 */

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
}

export interface TelegramMessage {
  message_id: number;
  from?: { id: number; is_bot?: boolean; username?: string };
  chat: { id: number; type: 'private' | 'group' | 'supergroup' | 'channel' };
  text?: string;
  caption?: string;
  entities?: TelegramEntity[];
  photo?: Array<{ file_id: string; file_unique_id: string; width: number; height: number }>;
}

export interface TelegramEntity {
  type: string; // 'mention' | 'bot_command' | ...
  offset: number;
  length: number;
}

export interface TelegramCallbackQuery {
  id: string;
  from: { id: number; username?: string };
  message?: { message_id: number; chat: { id: number } };
  data?: string;
}

export interface ParsedTelegramMessage {
  messageId: number;
  chatId: number;
  chatType: 'private' | 'group';
  /** Sender's numeric Telegram user id (stable; the allowlist key). */
  senderId: number;
  senderUsername: string;
  isBot: boolean;
  text: string;
  /** True if the message @-mentions the bot or starts with a `/command`. */
  mentionsBot: boolean;
  /** Largest photo file_id, if the message carries a photo. */
  photoFileId: string | null;
}

/**
 * Parse a Telegram message Update into our normalized shape.
 * Returns null for updates without a usable message (e.g. pure callback
 * queries, channel posts).
 *
 * `botUsername` (without the leading `@`) is used to detect @-mentions of
 * this bot in group chats. Pass an empty string to treat any `mention`
 * entity as a bot mention (best-effort before the bot's identity is known).
 */
export function parseMessageUpdate(
  update: TelegramUpdate,
  botUsername: string,
): ParsedTelegramMessage | null {
  const m = update.message;
  if (!m || !m.chat) return null;

  const text = (m.text ?? m.caption ?? '').trim();
  const chatType: 'private' | 'group' = m.chat.type === 'private' ? 'private' : 'group';

  const photo = m.photo ?? [];
  const photoFileId = photo.length > 0 ? (photo[photo.length - 1]?.file_id ?? null) : null;

  const mentionsBot = detectBotMention(m, text, botUsername);

  return {
    messageId: m.message_id,
    chatId: m.chat.id,
    chatType,
    senderId: m.from?.id ?? 0,
    senderUsername: m.from?.username ?? '',
    isBot: m.from?.is_bot === true,
    text,
    mentionsBot,
    photoFileId,
  };
}

function detectBotMention(m: TelegramMessage, text: string, botUsername: string): boolean {
  const entities = m.entities ?? [];
  for (const e of entities) {
    if (e.type === 'bot_command') return true;
    if (e.type === 'mention') {
      // A `mention` entity is `@username` literal text in the message.
      const mentionText = text.slice(e.offset, e.offset + e.length);
      if (!botUsername || mentionText.toLowerCase() === `@${botUsername.toLowerCase()}`) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Strip a leading `@botusername` mention and any `/command@bot` suffix from
 * the text, leaving the actual user content. Mirrors feishu's
 * stripMentionPrefix.
 */
export function stripBotMention(text: string, botUsername: string): string {
  let out = text;
  if (botUsername) {
    const re = new RegExp(`^@${escapeRegExp(botUsername)}\\s*`, 'i');
    out = out.replace(re, '');
  }
  // `/cmd@botname` → `/cmd`
  if (botUsername) {
    out = out.replace(new RegExp(`(/\\w+)@${escapeRegExp(botUsername)}`, 'gi'), '$1');
  }
  return out.trim();
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

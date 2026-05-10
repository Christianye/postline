/**
 * Parsing helpers for im.message.receive_v1 payloads.
 * Kept pure + unit-tested so we don't need the live SDK to validate.
 */

export interface ParsedMessage {
  messageId: string;
  chatId: string;
  chatType: 'p2p' | 'group';
  senderOpenId: string;
  senderType: string;
  text: string;
  mentionedOpenIds: readonly string[];
  /** Any image_key(s) found in the message content. Empty for pure-text messages. */
  imageKeys: readonly string[];
  rawContent: string;
  messageType: string;
}

export interface ReceiveV1Event {
  sender: {
    sender_id?: { open_id?: string; union_id?: string; user_id?: string };
    sender_type?: string;
  };
  message: {
    message_id: string;
    chat_id: string;
    chat_type?: string;
    message_type?: string;
    content?: string;
    mentions?: Array<{ id?: { open_id?: string } }>;
  };
}

export function parseReceiveV1(event: ReceiveV1Event): ParsedMessage | null {
  const m = event.message;
  if (!m) return null;
  const rawContent = m.content ?? '';
  let text = '';
  const imageKeys: string[] = [];

  if (m.message_type === 'text') {
    try {
      const parsed = JSON.parse(rawContent) as { text?: unknown };
      if (typeof parsed.text === 'string') text = parsed.text;
    } catch {
      text = rawContent;
    }
  } else if (m.message_type === 'image') {
    try {
      const parsed = JSON.parse(rawContent) as { image_key?: unknown };
      if (typeof parsed.image_key === 'string') imageKeys.push(parsed.image_key);
    } catch {
      // bad content — ignore, image list stays empty
    }
  } else if (m.message_type === 'post') {
    try {
      const parsed = JSON.parse(rawContent) as {
        content?: Array<Array<{ tag?: string; text?: string; image_key?: string }>>;
      };
      const segments = (parsed.content ?? []).flat();
      text = segments
        .map((seg) => (seg && typeof seg.text === 'string' ? seg.text : ''))
        .join('')
        .trim();
      for (const seg of segments) {
        if (seg?.tag === 'img' && typeof seg.image_key === 'string') {
          imageKeys.push(seg.image_key);
        }
      }
    } catch {
      text = rawContent;
    }
  }

  const mentionedOpenIds = (m.mentions ?? [])
    .map((x) => x.id?.open_id)
    .filter((x): x is string => typeof x === 'string');

  return {
    messageId: m.message_id,
    chatId: m.chat_id,
    chatType: (m.chat_type === 'group' ? 'group' : 'p2p') as 'p2p' | 'group',
    senderOpenId: event.sender?.sender_id?.open_id ?? '',
    senderType: event.sender?.sender_type ?? 'unknown',
    text,
    mentionedOpenIds,
    imageKeys,
    rawContent,
    messageType: m.message_type ?? 'unknown',
  };
}

/**
 * Strip @-mentions of a specific bot from the text.
 * Feishu text includes `@_user_1` placeholders; the mentions[] array maps them.
 * After the mention is our actual user content.
 */
export function stripMentionPrefix(text: string): string {
  // Remove leading @_user_N placeholders (with optional following space).
  return text.replace(/^(?:@_user_\d+\s*)+/u, '').trim();
}

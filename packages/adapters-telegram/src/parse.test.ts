import { describe, expect, it } from 'vitest';
import {
  type TelegramMessage,
  type TelegramUpdate,
  parseMessageUpdate,
  stripBotMention,
} from './parse.js';

function msgUpdate(over: Partial<TelegramMessage> = {}): TelegramUpdate {
  return {
    update_id: 100,
    message: {
      message_id: 5,
      from: { id: 42, username: 'chris' },
      chat: { id: 9, type: 'private' },
      text: 'hello',
      ...over,
    },
  };
}

describe('parseMessageUpdate', () => {
  it('parses a private text message (always passes mention gate)', () => {
    const p = parseMessageUpdate(msgUpdate(), 'mybot');
    expect(p?.chatType).toBe('private');
    expect(p?.senderId).toBe(42);
    expect(p?.text).toBe('hello');
    expect(p?.mentionsBot).toBe(false); // private doesn't need a mention
  });

  it('detects a bot_command entity as a mention', () => {
    const p = parseMessageUpdate(
      msgUpdate({
        chat: { id: 9, type: 'group' },
        text: '/review the diff',
        entities: [{ type: 'bot_command', offset: 0, length: 7 }],
      }),
      'mybot',
    );
    expect(p?.chatType).toBe('group');
    expect(p?.mentionsBot).toBe(true);
  });

  it('detects an @botusername mention in a group', () => {
    const text = '@mybot run lint';
    const p = parseMessageUpdate(
      msgUpdate({
        chat: { id: 9, type: 'group' },
        text,
        entities: [{ type: 'mention', offset: 0, length: 6 }],
      }),
      'mybot',
    );
    expect(p?.mentionsBot).toBe(true);
  });

  it('does NOT match a mention of a different bot', () => {
    const text = '@otherbot hi';
    const p = parseMessageUpdate(
      msgUpdate({
        chat: { id: 9, type: 'group' },
        text,
        entities: [{ type: 'mention', offset: 0, length: 9 }],
      }),
      'mybot',
    );
    expect(p?.mentionsBot).toBe(false);
  });

  it('picks the largest photo file_id', () => {
    // caption-only message (no text field)
    const u: TelegramUpdate = {
      update_id: 100,
      message: {
        message_id: 5,
        from: { id: 42, username: 'chris' },
        chat: { id: 9, type: 'private' },
        caption: 'look',
        photo: [
          { file_id: 'small', file_unique_id: 's', width: 90, height: 90 },
          { file_id: 'big', file_unique_id: 'b', width: 1280, height: 1280 },
        ],
      },
    };
    const p = parseMessageUpdate(u, 'mybot');
    expect(p?.photoFileId).toBe('big');
    expect(p?.text).toBe('look'); // caption used as text
  });

  it('returns null for a non-message update', () => {
    expect(parseMessageUpdate({ update_id: 1 }, 'mybot')).toBeNull();
  });
});

describe('stripBotMention', () => {
  it('strips a leading @botusername', () => {
    expect(stripBotMention('@mybot run lint', 'mybot')).toBe('run lint');
  });

  it('strips a /cmd@botname suffix down to /cmd', () => {
    expect(stripBotMention('/review@mybot the diff', 'mybot')).toBe('/review the diff');
  });

  it('is a no-op when the bot is not mentioned', () => {
    expect(stripBotMention('just a message', 'mybot')).toBe('just a message');
  });
});

import { describe, expect, it } from 'vitest';
import { type SlackMessageEvent, parseMessageEvent, stripBotMention } from './parse.js';

const BOT = 'U0BOT';

function ev(over: Partial<SlackMessageEvent> = {}): SlackMessageEvent {
  return { type: 'message', user: 'U0CHRIS', channel: 'C1', ts: '1.1', text: 'hi', ...over };
}

describe('parseMessageEvent', () => {
  it('parses a DM (im) — always passes mention gate', () => {
    const p = parseMessageEvent(ev({ channel_type: 'im' }), BOT);
    expect(p?.channelType).toBe('im');
    expect(p?.userId).toBe('U0CHRIS');
    expect(p?.mentionsBot).toBe(false);
  });

  it('detects an app_mention as a mention', () => {
    const p = parseMessageEvent(ev({ type: 'app_mention', channel_type: 'channel' }), BOT);
    expect(p?.mentionsBot).toBe(true);
  });

  it('detects <@BOT> mention text in a channel', () => {
    const p = parseMessageEvent(ev({ channel_type: 'channel', text: `<@${BOT}> run lint` }), BOT);
    expect(p?.mentionsBot).toBe(true);
  });

  it('does not match a mention of someone else', () => {
    const p = parseMessageEvent(ev({ channel_type: 'channel', text: '<@U0OTHER> hi' }), BOT);
    expect(p?.mentionsBot).toBe(false);
  });

  it('drops bot messages and subtypes', () => {
    expect(parseMessageEvent(ev({ bot_id: 'B1' }), BOT)).toBeNull();
    expect(parseMessageEvent(ev({ subtype: 'message_changed' }), BOT)).toBeNull();
  });

  it('drops non-message events', () => {
    expect(parseMessageEvent(ev({ type: 'reaction_added' }), BOT)).toBeNull();
  });

  it('extracts the first file url + mime', () => {
    const p = parseMessageEvent(
      ev({ files: [{ id: 'F1', url_private: 'https://files/x.png', mimetype: 'image/png' }] }),
      BOT,
    );
    expect(p?.file).toEqual({ url: 'https://files/x.png', mimeType: 'image/png' });
  });
});

describe('stripBotMention', () => {
  it('strips <@BOT>', () => {
    expect(stripBotMention(`<@${BOT}> do it`, BOT)).toBe('do it');
  });
  it('no-op without mention', () => {
    expect(stripBotMention('plain', BOT)).toBe('plain');
  });
});

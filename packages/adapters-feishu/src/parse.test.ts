import { describe, expect, it } from 'vitest';
import { parseReceiveV1, stripMentionPrefix } from './parse.js';

describe('parseReceiveV1', () => {
  it('extracts text + mentions from a group @CC message', () => {
    const p = parseReceiveV1({
      sender: {
        sender_id: { open_id: 'ou_user123' },
        sender_type: 'user',
      },
      message: {
        message_id: 'om_abc',
        chat_id: 'oc_xyz',
        chat_type: 'group',
        message_type: 'text',
        content: JSON.stringify({ text: '@_user_1 hi CC, what is 2+2?' }),
        mentions: [{ id: { open_id: 'ou_cc_bot' } }],
      },
    });
    expect(p).not.toBeNull();
    expect(p?.text).toBe('@_user_1 hi CC, what is 2+2?');
    expect(p?.mentionedOpenIds).toEqual(['ou_cc_bot']);
    expect(p?.chatType).toBe('group');
    expect(p?.senderOpenId).toBe('ou_user123');
    expect(p?.imageKeys).toEqual([]);
  });

  it('handles p2p text with no mentions', () => {
    const p = parseReceiveV1({
      sender: {
        sender_id: { open_id: 'ou_user123' },
        sender_type: 'user',
      },
      message: {
        message_id: 'om_abc',
        chat_id: 'p2p_xyz',
        chat_type: 'p2p',
        message_type: 'text',
        content: JSON.stringify({ text: 'hello' }),
      },
    });
    expect(p?.text).toBe('hello');
    expect(p?.chatType).toBe('p2p');
    expect(p?.mentionedOpenIds).toEqual([]);
    expect(p?.imageKeys).toEqual([]);
  });

  it('extracts image_key from pure image message', () => {
    const p = parseReceiveV1({
      sender: { sender_id: { open_id: 'ou_u' }, sender_type: 'user' },
      message: {
        message_id: 'om_img1',
        chat_id: 'p2p_a',
        chat_type: 'p2p',
        message_type: 'image',
        content: JSON.stringify({ image_key: 'img_v3_00_abc123' }),
      },
    });
    expect(p?.text).toBe('');
    expect(p?.imageKeys).toEqual(['img_v3_00_abc123']);
    expect(p?.messageType).toBe('image');
  });

  it('extracts image segments from post messages', () => {
    const p = parseReceiveV1({
      sender: { sender_id: { open_id: 'ou_u' }, sender_type: 'user' },
      message: {
        message_id: 'om_post1',
        chat_id: 'oc_x',
        chat_type: 'group',
        message_type: 'post',
        content: JSON.stringify({
          content: [
            [
              { tag: 'text', text: 'look at this: ' },
              { tag: 'img', image_key: 'img_aaa' },
              { tag: 'text', text: ' and ' },
              { tag: 'img', image_key: 'img_bbb' },
            ],
          ],
        }),
      },
    });
    expect(p?.text).toBe('look at this:  and');
    expect(p?.imageKeys).toEqual(['img_aaa', 'img_bbb']);
  });

  it('flattens post messages into plain text', () => {
    const p = parseReceiveV1({
      sender: { sender_id: { open_id: 'ou_u' }, sender_type: 'user' },
      message: {
        message_id: 'om_a',
        chat_id: 'oc_b',
        chat_type: 'group',
        message_type: 'post',
        content: JSON.stringify({
          content: [
            [
              { tag: 'text', text: 'Hi ' },
              { tag: 'at', user_id: 'ou_cc' },
              { tag: 'text', text: 'there' },
            ],
          ],
        }),
      },
    });
    expect(p?.text).toBe('Hi there');
  });

  it('returns null for missing message', () => {
    // @ts-expect-error deliberately wrong
    expect(parseReceiveV1({})).toBeNull();
  });
});

describe('stripMentionPrefix', () => {
  it('removes leading @_user_N', () => {
    expect(stripMentionPrefix('@_user_1 hello')).toBe('hello');
  });
  it('removes multiple leading @-mentions', () => {
    expect(stripMentionPrefix('@_user_1 @_user_2 hi')).toBe('hi');
  });
  it('leaves body @ intact', () => {
    expect(stripMentionPrefix('hi @_user_1 there')).toBe('hi @_user_1 there');
  });
});

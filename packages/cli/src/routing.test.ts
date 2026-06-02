import { describe, expect, it } from 'vitest';
import { isTrivialQuery, pickModel } from './routing.js';

describe('isTrivialQuery — conservative trivial classifier', () => {
  it('classifies short greetings as trivial', () => {
    expect(isTrivialQuery('hi', 50)).toBe(true);
    expect(isTrivialQuery('你好', 50)).toBe(true);
    expect(isTrivialQuery('thanks', 50)).toBe(true);
  });

  it('rejects empty input', () => {
    expect(isTrivialQuery('', 50)).toBe(false);
    expect(isTrivialQuery('   ', 50)).toBe(false);
  });

  it('rejects text exceeding the length cap', () => {
    expect(isTrivialQuery('a'.repeat(60), 50)).toBe(false);
  });

  it('rejects English action verbs', () => {
    expect(isTrivialQuery('run ls', 50)).toBe(false);
    expect(isTrivialQuery('please check the deploy', 50)).toBe(false);
    expect(isTrivialQuery('explain this', 50)).toBe(false);
    expect(isTrivialQuery('search github', 50)).toBe(false);
  });

  it('rejects Chinese intent verbs', () => {
    expect(isTrivialQuery('帮我看下', 50)).toBe(false);
    expect(isTrivialQuery('跑一下 ls', 50)).toBe(false);
    expect(isTrivialQuery('为什么没工作', 50)).toBe(false);
    expect(isTrivialQuery('怎么用', 50)).toBe(false);
    expect(isTrivialQuery('解释下', 50)).toBe(false);
  });

  it('rejects shell / path / url tokens', () => {
    expect(isTrivialQuery('try sudo', 50)).toBe(false);
    expect(isTrivialQuery('what about /home/me', 50)).toBe(false);
    expect(isTrivialQuery('see https://x.com', 50)).toBe(false);
  });

  it('rejects multi-line input', () => {
    expect(isTrivialQuery('line 1\nline 2', 50)).toBe(false);
  });

  it('keeps "what" as a base accepting question if short and no action verb', () => {
    expect(isTrivialQuery('what', 50)).toBe(true);
  });
});

describe('pickModel — config-gated routing', () => {
  const PRIMARY = 'amazon-bedrock/us.anthropic.claude-opus-4-7';
  const SMALL = 'amazon-bedrock/global.anthropic.claude-haiku-4-5-20251001-v1:0';

  it('returns primary when routing config is undefined', () => {
    expect(pickModel(PRIMARY, 'hi', undefined)).toBe(PRIMARY);
  });

  it('returns primary when routing.enabled is false', () => {
    expect(pickModel(PRIMARY, 'hi', { enabled: false })).toBe(PRIMARY);
  });

  it('returns small model on a trivial query when routing enabled', () => {
    expect(pickModel(PRIMARY, 'hi', { enabled: true })).toBe(SMALL);
  });

  it('returns primary on non-trivial query even when routing enabled', () => {
    expect(pickModel(PRIMARY, '帮我跑一下 ls', { enabled: true })).toBe(PRIMARY);
  });

  it('honors a custom smallModel id when provided', () => {
    expect(pickModel(PRIMARY, 'hi', { enabled: true, smallModel: 'custom/x' })).toBe('custom/x');
  });

  it('honors a custom trivialMaxChars cap', () => {
    expect(pickModel(PRIMARY, 'a'.repeat(40), { enabled: true, trivialMaxChars: 30 })).toBe(
      PRIMARY,
    );
    expect(pickModel(PRIMARY, 'a'.repeat(40), { enabled: true, trivialMaxChars: 50 })).toBe(SMALL);
  });
});

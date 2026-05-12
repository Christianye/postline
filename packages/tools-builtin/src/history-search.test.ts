import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type Message, type ToolContext, createLogger } from '@postline/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHistorySearchTool } from './history-search.js';

const log = createLogger({ level: 'silent' });
const ctx = (): ToolContext => ({
  userId: 'ou_me',
  conversationId: 'c',
  log,
  signal: new AbortController().signal,
});

function msg(role: Message['role'], text: string): Message {
  return { role, content: [{ type: 'text', text }] };
}

function writeConversation(dir: string, hash: string, msgs: Message[]): void {
  writeFileSync(join(dir, `${hash}.jsonl`), `${msgs.map((m) => JSON.stringify(m)).join('\n')}\n`);
}

describe('history_search', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'postline-hist-search-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('requires query', async () => {
    const tool = createHistorySearchTool({ dir });
    const r = await tool.run({}, ctx());
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/query is required/);
  });

  it('reports "history dir does not exist" when missing', async () => {
    const tool = createHistorySearchTool({ dir: join(dir, 'nope') });
    const r = await tool.run({ query: 'anything' }, ctx());
    expect(r.content).toMatch(/history dir does not exist/);
  });

  it('reports "(no conversation history yet)" when dir empty', async () => {
    const tool = createHistorySearchTool({ dir });
    const r = await tool.run({ query: 'anything' }, ctx());
    expect(r.content).toMatch(/no conversation history/);
  });

  it('finds literal substring across conversations, case-insensitive by default', async () => {
    writeConversation(dir, 'hash_a', [
      msg('user', 'What about DynamoDB GSI?'),
      msg('assistant', 'We can reshape the partition.'),
    ]);
    writeConversation(dir, 'hash_b', [msg('user', 'unrelated content')]);
    const tool = createHistorySearchTool({ dir });
    const r = await tool.run({ query: 'dynamodb' }, ctx());
    expect(r.meta?.hits).toBe(1);
    expect(r.content).toContain('hash_a');
    expect(r.content).toContain('[user]');
    expect(r.content).toContain('DynamoDB');
  });

  it('finds matches in assistant + tool_result content', async () => {
    writeConversation(dir, 'h1', [
      msg('user', 'check logs'),
      msg('assistant', 'looking it up'),
      {
        role: 'tool',
        content: [{ type: 'tool_result', toolUseId: 't1', content: 'ERROR kafka rebalance' }],
      },
    ]);
    const tool = createHistorySearchTool({ dir });
    const r = await tool.run({ query: 'kafka' }, ctx());
    expect(r.meta?.hits).toBe(1);
    expect(r.content).toContain('tool');
  });

  it('respects case_sensitive=true', async () => {
    writeConversation(dir, 'a', [msg('user', 'Alpha'), msg('assistant', 'alpha')]);
    const tool = createHistorySearchTool({ dir });
    const r = await tool.run({ query: 'Alpha', case_sensitive: true }, ctx());
    expect(r.meta?.hits).toBe(1);
  });

  it('treats query as regex when regex=true', async () => {
    writeConversation(dir, 'a', [msg('user', 'foo'), msg('user', 'bar'), msg('user', 'foobar')]);
    const tool = createHistorySearchTool({ dir });
    const r = await tool.run({ query: '^foo', regex: true }, ctx());
    // matches 'foo' and 'foobar' at start
    expect(r.meta?.hits).toBe(2);
  });

  it('escapes regex metacharacters in literal mode', async () => {
    writeConversation(dir, 'a', [msg('user', 'price: $10.50'), msg('user', '$10 only')]);
    const tool = createHistorySearchTool({ dir });
    const r = await tool.run({ query: '$10.50' }, ctx());
    expect(r.meta?.hits).toBe(1);
  });

  it('rejects invalid regex gracefully', async () => {
    writeConversation(dir, 'a', [msg('user', 'x')]);
    const tool = createHistorySearchTool({ dir });
    const r = await tool.run({ query: '[unterminated', regex: true }, ctx());
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/invalid regex/);
  });

  it('honours max_hits and marks truncated', async () => {
    const many: Message[] = [];
    for (let i = 0; i < 10; i++) many.push(msg('user', `target #${i}`));
    writeConversation(dir, 'many', many);
    const tool = createHistorySearchTool({ dir });
    const r = await tool.run({ query: 'target', max_hits: 3 }, ctx());
    expect(r.meta?.truncated).toBe(true);
    expect(r.meta?.hits).toBeGreaterThanOrEqual(3);
  });

  it('skips non-.jsonl files', async () => {
    writeConversation(dir, 'a', [msg('user', 'findme')]);
    writeFileSync(join(dir, 'notes.txt'), 'findme');
    writeFileSync(join(dir, 'README.md'), 'findme');
    const tool = createHistorySearchTool({ dir });
    const r = await tool.run({ query: 'findme' }, ctx());
    expect(r.meta?.hits).toBe(1);
    expect(r.content).not.toContain('notes.txt');
  });

  it('skips corrupt JSONL lines without crashing', async () => {
    writeFileSync(
      join(dir, 'h.jsonl'),
      [JSON.stringify(msg('user', 'valid target')), '{this is not json}', '', ''].join('\n'),
    );
    const tool = createHistorySearchTool({ dir });
    const r = await tool.run({ query: 'target' }, ctx());
    expect(r.meta?.hits).toBe(1);
  });

  it('returns a clean no-match message with hits=0', async () => {
    writeConversation(dir, 'h', [msg('user', 'only this')]);
    const tool = createHistorySearchTool({ dir });
    const r = await tool.run({ query: 'nothere' }, ctx());
    expect(r.meta?.hits).toBe(0);
    expect(r.content).toMatch(/no match/);
  });

  it('filters by hours window via mtime', async () => {
    writeConversation(dir, 'a', [msg('user', 'old match')]);
    writeConversation(dir, 'b', [msg('user', 'fresh match')]);
    // Make 'a' look 48h old by utimes
    const fs = await import('node:fs/promises');
    const oldTime = new Date(Date.now() - 48 * 60 * 60 * 1000);
    await fs.utimes(join(dir, 'a.jsonl'), oldTime, oldTime);
    const tool = createHistorySearchTool({ dir });
    const r = await tool.run({ query: 'match', hours: 24 }, ctx());
    expect(r.meta?.hits).toBe(1);
    expect(r.content).toContain('fresh');
    expect(r.content).not.toContain('old match');
  });
});

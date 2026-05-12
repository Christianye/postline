import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type Tool, type ToolContext, createLogger } from '@postline/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createMemoryTools } from './memory.js';

const log = createLogger({ level: 'silent' });
const ctx = (): ToolContext => ({
  userId: 'ou_me',
  conversationId: 'c',
  log,
  signal: new AbortController().signal,
});

describe('memory_search', () => {
  let dir: string;
  let search: Tool;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cc-memory-'));
    const tools = createMemoryTools({ dir, gitPush: false });
    const t = tools.find((x) => x.name === 'memory_search');
    if (!t) throw new Error('memory_search not registered');
    search = t;
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function write(name: string, body: string): void {
    writeFileSync(join(dir, name), body);
  }

  it('requires query', async () => {
    const r = await search.run({}, ctx());
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/query is required/);
  });

  it('returns (memory dir not initialized) when dir missing', async () => {
    rmSync(dir, { recursive: true, force: true });
    const r = await search.run({ query: 'anything' }, ctx());
    expect(r.content).toMatch(/not initialized/);
  });

  it('finds literal substring across files, case-insensitive by default', async () => {
    write('a.md', 'Hello World\nnot relevant');
    write('b.md', 'another HELLO here');
    const r = await search.run({ query: 'hello' }, ctx());
    expect(r.content).toContain('a.md');
    expect(r.content).toContain('b.md');
    expect(r.content).toContain('1: Hello World');
    expect(r.content).toContain('1: another HELLO here');
    expect(r.meta?.hits).toBe(2);
  });

  it('respects case_sensitive=true', async () => {
    write('a.md', 'Hello\nhello');
    const r = await search.run({ query: 'Hello', case_sensitive: true }, ctx());
    expect(r.content).toContain('1: Hello');
    expect(r.content).not.toContain('2: hello');
    expect(r.meta?.hits).toBe(1);
  });

  it('treats query as regex when regex=true', async () => {
    write('a.md', 'foo\nbar\nfoobar');
    const r = await search.run({ query: '^foo', regex: true }, ctx());
    expect(r.meta?.hits).toBe(2);
    expect(r.content).toContain('foo');
    expect(r.content).toContain('foobar');
  });

  it('literal mode escapes regex metacharacters', async () => {
    write('a.md', 'price: $10.50\nprice 10 only');
    const r = await search.run({ query: '$10.50' }, ctx());
    expect(r.meta?.hits).toBe(1);
    expect(r.content).toContain('$10.50');
  });

  it('returns a clean "no match" message with hits=0', async () => {
    write('a.md', 'foo');
    const r = await search.run({ query: 'bar' }, ctx());
    expect(r.content).toMatch(/no match/);
    expect(r.meta?.hits).toBe(0);
  });

  it('honours max_hits and flags truncated', async () => {
    // 5 lines match, we cap to 2
    write('a.md', ['x', 'x', 'x', 'x', 'x'].join('\n'));
    const r = await search.run({ query: 'x', max_hits: 2 }, ctx());
    expect(r.meta?.truncated).toBe(true);
    // Header reports the ACTUAL hit count (we still count past the cap), even
    // though the listing stops at max_hits.
    expect(r.meta?.hits).toBeGreaterThanOrEqual(2);
  });

  it('rejects invalid regex gracefully', async () => {
    write('a.md', 'foo');
    const r = await search.run({ query: '[unterminated', regex: true }, ctx());
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/invalid regex/);
  });

  it('skips dotfiles and non-.md entries', async () => {
    write('a.md', 'findme');
    write('.hidden.md', 'findme');
    write('readme.txt', 'findme');
    const r = await search.run({ query: 'findme' }, ctx());
    expect(r.meta?.hits).toBe(1);
    expect(r.content).toContain('a.md');
    expect(r.content).not.toContain('.hidden');
    expect(r.content).not.toContain('readme.txt');
  });

  it('trims absurdly long lines to 200 chars + ellipsis', async () => {
    const longLine = 'x'.repeat(500);
    write('a.md', `${longLine}findme`);
    const r = await search.run({ query: 'findme' }, ctx());
    expect(r.content).toMatch(/…/);
  });
});

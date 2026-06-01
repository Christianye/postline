import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Message } from '@postline/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  auditHistoryDir,
  auditHistoryMessages,
  createFsHistory,
  listHistoryConversations,
  sanitizeHistory,
} from './history-fs.js';

describe('createFsHistory', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'postline-hist-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const msg = (role: 'user' | 'assistant', text: string): Message => ({
    role,
    content: [{ type: 'text', text }],
  });

  it('load returns [] for an unknown conversation', async () => {
    const h = createFsHistory({ dir });
    expect(await h.load('never-seen', 10)).toEqual([]);
  });

  it('append + load round-trips messages', async () => {
    const h = createFsHistory({ dir });
    await h.append('c1', [msg('user', 'hi'), msg('assistant', 'hello')]);
    const loaded = await h.load('c1', 10);
    expect(loaded).toHaveLength(2);
    expect(loaded[0]).toEqual(msg('user', 'hi'));
    expect(loaded[1]).toEqual(msg('assistant', 'hello'));
  });

  it('append is idempotent — each call is additive', async () => {
    const h = createFsHistory({ dir });
    await h.append('c1', [msg('user', 'one')]);
    await h.append('c1', [msg('assistant', 'two')]);
    await h.append('c1', [msg('user', 'three')]);
    const loaded = await h.load('c1', 10);
    expect(loaded.map((m) => (m.content[0] as { text: string }).text)).toEqual([
      'one',
      'two',
      'three',
    ]);
  });

  it('load respects `limit` by returning the most recent N', async () => {
    const h = createFsHistory({ dir });
    for (let i = 0; i < 5; i++) {
      await h.append('c1', [msg('user', `m${i}`)]);
    }
    const loaded = await h.load('c1', 2);
    expect(loaded.map((m) => (m.content[0] as { text: string }).text)).toEqual(['m3', 'm4']);
  });

  it('isolates conversations', async () => {
    const h = createFsHistory({ dir });
    await h.append('chat_a', [msg('user', 'alpha')]);
    await h.append('chat_b', [msg('user', 'beta')]);
    expect((await h.load('chat_a', 10))[0]).toMatchObject({
      content: [{ text: 'alpha' }],
    });
    expect((await h.load('chat_b', 10))[0]).toMatchObject({
      content: [{ text: 'beta' }],
    });
  });

  it('hashes arbitrary conversation ids to safe filenames', async () => {
    const h = createFsHistory({ dir });
    await h.append('oc_/weird:id with spaces', [msg('user', 'x')]);
    // We don't check the exact filename (implementation detail), but the file
    // should exist and contain the message.
    const { readdirSync } = await import('node:fs');
    const files = readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
    expect(files).toHaveLength(1);
    expect(readFileSync(join(dir, files[0]!), 'utf8')).toContain('"text":"x"');
  });

  it('appends survive a new store instance (aka bot restart)', async () => {
    const h1 = createFsHistory({ dir });
    await h1.append('c1', [msg('user', 'persisted')]);

    const h2 = createFsHistory({ dir });
    const loaded = await h2.load('c1', 10);
    expect(loaded[0]).toEqual(msg('user', 'persisted'));
  });

  it('skips a corrupt JSONL line rather than blowing up', async () => {
    const h = createFsHistory({ dir });
    await h.append('c1', [msg('user', 'valid1'), msg('user', 'valid2')]);
    // Now tamper: append a malformed line
    const { createHash } = await import('node:crypto');
    const path = join(dir, `${createHash('md5').update('c1').digest('hex').slice(0, 16)}.jsonl`);
    writeFileSync(
      path,
      `${readFileSync(path, 'utf8')}{this is not json}\n${JSON.stringify(msg('assistant', 'valid3'))}\n`,
    );
    const loaded = await h.load('c1', 10);
    // Should get 3 valid messages, corrupt line dropped
    expect(loaded).toHaveLength(3);
    expect(loaded[2]).toEqual(msg('assistant', 'valid3'));
  });

  it('append([]) is a no-op', async () => {
    const h = createFsHistory({ dir });
    await h.append('c1', []);
    expect(await h.load('c1', 10)).toEqual([]);
  });

  it('creates the dir if it does not exist', async () => {
    const nested = join(dir, 'nested', 'two');
    const h = createFsHistory({ dir: nested });
    await h.append('c1', [msg('user', 'created')]);
    expect(await h.load('c1', 10)).toHaveLength(1);
  });
});

describe('sanitizeHistory (orphan tool_use guard)', () => {
  const userMsg = (text: string): Message => ({ role: 'user', content: [{ type: 'text', text }] });
  const assistantWithToolUse = (id: string, text = ''): Message => ({
    role: 'assistant',
    content: [
      ...(text ? ([{ type: 'text', text }] as const) : []),
      { type: 'tool_use', id, name: 'bash', input: {} },
    ],
  });
  const toolResultMsg = (id: string, content = 'ok'): Message => ({
    role: 'tool',
    content: [{ type: 'tool_result', toolUseId: id, content }],
  });

  it('passes through plain text history unchanged', () => {
    const h = [userMsg('hi'), { role: 'assistant', content: [{ type: 'text', text: 'hello' }] }];
    expect(sanitizeHistory(h as Message[])).toEqual(h);
  });

  it('keeps assistant tool_use when followed by matching tool_result', () => {
    const h = [
      userMsg('do it'),
      assistantWithToolUse('tu_1'),
      toolResultMsg('tu_1', 'done'),
      { role: 'assistant', content: [{ type: 'text', text: 'all set' }] } as Message,
    ];
    expect(sanitizeHistory(h)).toEqual(h);
  });

  it('drops orphan assistant tool_use with no following tool message', () => {
    const h = [userMsg('do it'), assistantWithToolUse('tu_orphan', 'about to call')];
    const out = sanitizeHistory(h);
    expect(out).toEqual([userMsg('do it')]);
  });

  it('drops orphan when next message is tool but ids do not match', () => {
    const h = [
      userMsg('do it'),
      assistantWithToolUse('tu_real'),
      toolResultMsg('tu_other', 'wrong'),
      userMsg('next turn'),
    ];
    const out = sanitizeHistory(h);
    // The orphan assistant + its mismatched tool message are both dropped;
    // the trailing user message survives.
    expect(out).toEqual([userMsg('do it'), userMsg('next turn')]);
  });

  it('keeps the rest of history when an orphan is dropped from the head', () => {
    const h = [
      assistantWithToolUse('tu_orphan'),
      userMsg('user kept talking'),
      { role: 'assistant', content: [{ type: 'text', text: 'kept' }] } as Message,
    ];
    const out = sanitizeHistory(h);
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual(userMsg('user kept talking'));
  });
});

describe('createFsHistory load-side sanitize integration', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'postline-hist-sanitize-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('strips orphan tool_use rows already on disk (covers pre-fix pollution)', async () => {
    // Simulate a jsonl file written by the buggy pre-fix code path: an assistant
    // message with tool_use but no tool_result follows.
    const { createHash } = await import('node:crypto');
    const path = join(dir, `${createHash('md5').update('cid').digest('hex').slice(0, 16)}.jsonl`);
    const lines = [
      { role: 'user', content: [{ type: 'text', text: 'run something' }] },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'let me try' },
          { type: 'tool_use', id: 'tu_old', name: 'bash', input: {} },
        ],
      },
    ];
    writeFileSync(path, `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`);

    const h = createFsHistory({ dir });
    const loaded = await h.load('cid', 10);
    // Orphan dropped; only the user turn survives.
    expect(loaded).toHaveLength(1);
    expect(loaded[0]).toMatchObject({ role: 'user' });
  });
});

describe('listHistoryConversations', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'postline-hist-list-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns [] for a missing dir', async () => {
    expect(await listHistoryConversations(join(dir, 'nope'))).toEqual([]);
  });

  it('lists every jsonl file with size', async () => {
    const h = createFsHistory({ dir });
    await h.append('one', [{ role: 'user', content: [{ type: 'text', text: 'x' }] }]);
    await h.append('two', [{ role: 'user', content: [{ type: 'text', text: 'yy' }] }]);
    const out = await listHistoryConversations(dir);
    expect(out).toHaveLength(2);
    for (const entry of out) {
      expect(entry.sizeBytes).toBeGreaterThan(0);
    }
  });
});

describe('auditHistoryMessages — count-only orphan detection', () => {
  it('clean conversation: zero orphans', () => {
    const msgs: Message[] = [
      { role: 'user', content: [{ type: 'text', text: 'hi' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'hello' }] },
    ];
    const out = auditHistoryMessages(msgs);
    expect(out).toEqual({ rows: 2, orphanToolUseRows: 0, standaloneToolRows: 0 });
  });

  it('orphan assistant tool_use without following tool_result is counted', () => {
    const msgs: Message[] = [
      { role: 'user', content: [{ type: 'text', text: 'do' }] },
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'tu_x', name: 'bash', input: {} }],
      },
    ];
    const out = auditHistoryMessages(msgs);
    expect(out.orphanToolUseRows).toBe(1);
    expect(out.standaloneToolRows).toBe(0);
  });

  it('standalone tool message is counted', () => {
    const msgs: Message[] = [
      { role: 'tool', content: [{ type: 'tool_result', toolUseId: 'tu_y', content: 'leftover' }] },
      { role: 'user', content: [{ type: 'text', text: 'next' }] },
    ];
    const out = auditHistoryMessages(msgs);
    expect(out.orphanToolUseRows).toBe(0);
    expect(out.standaloneToolRows).toBe(1);
  });

  it('paired tool_use + tool_result is NOT an orphan', () => {
    const msgs: Message[] = [
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'tu_p', name: 'bash', input: {} }],
      },
      { role: 'tool', content: [{ type: 'tool_result', toolUseId: 'tu_p', content: 'ok' }] },
    ];
    const out = auditHistoryMessages(msgs);
    expect(out.orphanToolUseRows).toBe(0);
    expect(out.standaloneToolRows).toBe(0);
  });

  it('mismatched ids: assistant counted as orphan, mismatched tool counted as standalone', () => {
    const msgs: Message[] = [
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'tu_a', name: 'bash', input: {} }],
      },
      { role: 'tool', content: [{ type: 'tool_result', toolUseId: 'tu_other', content: '?' }] },
    ];
    const out = auditHistoryMessages(msgs);
    expect(out.orphanToolUseRows).toBe(1);
    expect(out.standaloneToolRows).toBe(1);
  });
});

describe('auditHistoryDir — directory walk', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'postline-hist-audit-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns zero totals for a missing dir', async () => {
    const out = await auditHistoryDir(join(dir, 'nope'));
    expect(out.total).toEqual({ files: 0, rows: 0, orphans: 0, corruptLines: 0 });
    expect(out.files).toEqual([]);
  });

  it('aggregates across multiple files, ranking by orphan count', async () => {
    const { createHash } = await import('node:crypto');
    const hashFile = (cid: string): string =>
      `${createHash('md5').update(cid).digest('hex').slice(0, 16)}.jsonl`;
    // clean chat
    writeFileSync(
      join(dir, hashFile('clean')),
      `${JSON.stringify({ role: 'user', content: [{ type: 'text', text: 'hi' }] })}\n`,
    );
    // orphan-heavy chat (2 orphan tool_use + 1 standalone tool)
    const orphanLines = [
      { role: 'user', content: [{ type: 'text', text: 'do' }] },
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'tu_1', name: 'bash', input: {} }],
      },
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'tu_2', name: 'bash', input: {} }],
      },
      {
        role: 'tool',
        content: [{ type: 'tool_result', toolUseId: 'tu_lone', content: 'leftover' }],
      },
    ];
    writeFileSync(
      join(dir, hashFile('messy')),
      `${orphanLines.map((l) => JSON.stringify(l)).join('\n')}\n`,
    );

    const out = await auditHistoryDir(dir);
    expect(out.total.files).toBe(2);
    expect(out.total.orphans).toBe(3); // 2 orphan_tool_use + 1 standalone_tool
    const messy = out.files.find((f) => f.totalOrphans > 0);
    expect(messy).toBeDefined();
    expect(messy?.orphanToolUseRows).toBe(2);
    expect(messy?.standaloneToolRows).toBe(1);
  });

  it('counts corrupt JSON lines without crashing', async () => {
    const { createHash } = await import('node:crypto');
    const path = join(dir, `${createHash('md5').update('cid').digest('hex').slice(0, 16)}.jsonl`);
    writeFileSync(
      path,
      `${JSON.stringify({ role: 'user', content: [{ type: 'text', text: 'ok' }] })}\nthis is not json\n`,
    );
    const out = await auditHistoryDir(dir);
    expect(out.total.corruptLines).toBe(1);
    expect(out.total.rows).toBe(1);
  });
});

import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createLogger, type ToolContext } from '@postline/core';
import { createFsTools } from './fs.js';

const log = createLogger({ level: 'silent' });
const ctx = (): ToolContext => ({
  userId: 'ou_me',
  conversationId: 'c',
  log,
  signal: new AbortController().signal,
});

describe('fs tools', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cc-fs-'));
  const [read, write, edit] = createFsTools({ readAllow: [dir], writeAllow: [dir] });

  it('read: inside allow', async () => {
    const p = join(dir, 'x.txt');
    writeFileSync(p, 'hello');
    const r = await read!.run({ path: p }, ctx());
    expect(r.isError).toBeUndefined();
    expect(r.content).toBe('hello');
  });

  it('read: outside allow denied', async () => {
    const r = await read!.run({ path: '/etc/passwd' }, ctx());
    expect(r.isError).toBe(true);
    expect(r.content).toContain('outside readAllow');
  });

  it('write: inside allow', async () => {
    const p = join(dir, 'w.txt');
    const r = await write!.run({ path: p, content: 'world' }, ctx());
    expect(r.isError).toBeUndefined();
    expect(readFileSync(p, 'utf8')).toBe('world');
  });

  it('write: outside allow denied', async () => {
    const r = await write!.run({ path: '/etc/evil', content: 'x' }, ctx());
    expect(r.isError).toBe(true);
  });

  it('edit: unique replace ok', async () => {
    const p = join(dir, 'e.txt');
    writeFileSync(p, 'the quick brown fox');
    const r = await edit!.run({ path: p, old_string: 'quick', new_string: 'slow' }, ctx());
    expect(r.isError).toBeUndefined();
    expect(readFileSync(p, 'utf8')).toBe('the slow brown fox');
  });

  it('edit: ambiguous string fails', async () => {
    const p = join(dir, 'e2.txt');
    writeFileSync(p, 'a a a');
    const r = await edit!.run({ path: p, old_string: 'a', new_string: 'b' }, ctx());
    expect(r.isError).toBe(true);
  });

  it('edit: not found fails', async () => {
    const p = join(dir, 'e3.txt');
    writeFileSync(p, 'hello');
    const r = await edit!.run({ path: p, old_string: 'x', new_string: 'y' }, ctx());
    expect(r.isError).toBe(true);
  });

  it('path traversal blocked', async () => {
    const r = await read!.run({ path: `${dir}/../../etc/passwd` }, ctx());
    expect(r.isError).toBe(true);
  });
});

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadClaudeCodeServers, resolveServers } from './config-loader.js';

describe('config-loader', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'postline-mcp-test-'));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('returns empty map when file is missing', async () => {
    const result = await loadClaudeCodeServers(join(tmp, 'nonexistent.json'));
    expect(result).toEqual({});
  });

  it('returns empty map when mcpServers field is absent', async () => {
    const p = join(tmp, 'claude.json');
    writeFileSync(p, JSON.stringify({ theme: 'dark' }));
    const result = await loadClaudeCodeServers(p);
    expect(result).toEqual({});
  });

  it('parses claude-code style stdio entries', async () => {
    const p = join(tmp, 'claude.json');
    writeFileSync(
      p,
      JSON.stringify({
        mcpServers: {
          fs: {
            type: 'stdio',
            command: 'mcp-fs',
            args: ['--root', '/tmp'],
            env: { FOO: 'bar' },
          },
          bare: { command: 'just-a-bin' },
        },
      }),
    );
    const result = await loadClaudeCodeServers(p);
    expect(Object.keys(result).sort()).toEqual(['bare', 'fs']);
    expect(result.fs?.command).toBe('mcp-fs');
    expect(result.fs?.args).toEqual(['--root', '/tmp']);
    expect(result.fs?.env).toEqual({ FOO: 'bar' });
    expect(result.bare?.command).toBe('just-a-bin');
  });

  it('skips non-stdio transport entries', async () => {
    const p = join(tmp, 'claude.json');
    writeFileSync(
      p,
      JSON.stringify({
        mcpServers: {
          sse: { type: 'sse', url: 'https://x' },
          stdio: { command: 'foo' },
        },
      }),
    );
    const result = await loadClaudeCodeServers(p);
    expect(Object.keys(result)).toEqual(['stdio']);
  });

  it('throws on malformed JSON', async () => {
    const p = join(tmp, 'claude.json');
    writeFileSync(p, '{ not json');
    await expect(loadClaudeCodeServers(p)).rejects.toThrow(/not valid JSON/);
  });

  it('resolveServers honours source=postline', async () => {
    const p = join(tmp, 'claude.json');
    writeFileSync(p, JSON.stringify({ mcpServers: { a: { command: 'cc' } } }));
    const merged = await resolveServers({
      source: 'postline',
      servers: { b: { command: 'inline' } },
      claudeConfigPath: p,
    });
    expect(Object.keys(merged)).toEqual(['b']);
  });

  it('resolveServers honours source=claude-code', async () => {
    const p = join(tmp, 'claude.json');
    writeFileSync(p, JSON.stringify({ mcpServers: { a: { command: 'cc' } } }));
    const merged = await resolveServers({
      source: 'claude-code',
      servers: { b: { command: 'inline' } },
      claudeConfigPath: p,
    });
    expect(Object.keys(merged)).toEqual(['a']);
  });

  it('resolveServers merges with inline winning on conflict', async () => {
    const p = join(tmp, 'claude.json');
    writeFileSync(
      p,
      JSON.stringify({ mcpServers: { shared: { command: 'from-claude' }, a: { command: 'cc' } } }),
    );
    const merged = await resolveServers({
      source: 'both',
      servers: { shared: { command: 'from-inline' }, b: { command: 'inline' } },
      claudeConfigPath: p,
    });
    expect(Object.keys(merged).sort()).toEqual(['a', 'b', 'shared']);
    expect(merged.shared?.command).toBe('from-inline');
  });
});

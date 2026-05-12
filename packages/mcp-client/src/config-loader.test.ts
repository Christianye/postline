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
    expect((result.fs as { command?: string } | undefined)?.command).toBe('mcp-fs');
    expect((result.fs as { args?: readonly string[] } | undefined)?.args).toEqual([
      '--root',
      '/tmp',
    ]);
    expect((result.fs as { env?: Record<string, unknown> } | undefined)?.env).toEqual({
      FOO: 'bar',
    });
    expect((result.bare as { command?: string } | undefined)?.command).toBe('just-a-bin');
  });

  it('parses http transport entries', async () => {
    const p = join(tmp, 'claude.json');
    writeFileSync(
      p,
      JSON.stringify({
        mcpServers: {
          remote: {
            type: 'http',
            url: 'https://mcp.example.com/v1',
            headers: { Authorization: 'Bearer xyz', 'X-Client': 'postline' },
          },
        },
      }),
    );
    const result = await loadClaudeCodeServers(p);
    expect(result.remote).toMatchObject({
      type: 'http',
      url: 'https://mcp.example.com/v1',
      headers: { Authorization: 'Bearer xyz', 'X-Client': 'postline' },
    });
  });

  it('parses streamable-http alias the same as http', async () => {
    const p = join(tmp, 'claude.json');
    writeFileSync(
      p,
      JSON.stringify({
        mcpServers: { s: { type: 'streamable-http', url: 'https://x' } },
      }),
    );
    const result = await loadClaudeCodeServers(p);
    expect(result.s?.type).toBe('streamable-http');
  });

  it('parses sse transport entries', async () => {
    const p = join(tmp, 'claude.json');
    writeFileSync(
      p,
      JSON.stringify({
        mcpServers: { legacy: { type: 'sse', url: 'https://x/sse' } },
      }),
    );
    const result = await loadClaudeCodeServers(p);
    expect(result.legacy?.type).toBe('sse');
  });

  it('skips http entries missing url', async () => {
    const p = join(tmp, 'claude.json');
    writeFileSync(
      p,
      JSON.stringify({
        mcpServers: {
          broken: { type: 'http' }, // no url
          ok: { type: 'http', url: 'https://y' },
        },
      }),
    );
    const result = await loadClaudeCodeServers(p);
    expect(Object.keys(result)).toEqual(['ok']);
  });

  it('skips entries with unknown transport type', async () => {
    const p = join(tmp, 'claude.json');
    writeFileSync(
      p,
      JSON.stringify({
        mcpServers: {
          junk: { type: 'ws', url: 'wss://x' },
          good: { command: 'foo' },
        },
      }),
    );
    const result = await loadClaudeCodeServers(p);
    expect(Object.keys(result)).toEqual(['good']);
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
    expect((merged.shared as { command?: string } | undefined)?.command).toBe('from-inline');
  });
});

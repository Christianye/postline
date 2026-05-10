import { describe, expect, it } from 'vitest';
import { createBashTool } from './bash.js';
import { createLogger } from '@postline/core';
import type { ToolContext } from '@postline/core';

const log = createLogger({ level: 'silent' });

function ctx(): ToolContext {
  const ac = new AbortController();
  return {
    userId: 'ou_me',
    conversationId: 'c1',
    log,
    signal: ac.signal,
  };
}

describe('bash tool', () => {
  it('runs a successful command', async () => {
    const t = createBashTool();
    const r = await t.run({ command: 'echo hello' }, ctx());
    expect(r.isError).toBeUndefined();
    expect(r.content).toContain('hello');
    expect(r.content).toContain('exit 0');
  });

  it('reports non-zero exit as error', async () => {
    const t = createBashTool();
    const r = await t.run({ command: 'false' }, ctx());
    expect(r.isError).toBe(true);
    expect(r.content).toContain('exit 1');
  });

  it('blocks deny-listed commands', async () => {
    const t = createBashTool();
    const r = await t.run({ command: 'rm -rf /' }, ctx());
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/deny pattern/);
  });

  it('enforces timeout', async () => {
    const t = createBashTool({ timeoutMs: 200 });
    const r = await t.run({ command: 'sleep 5' }, ctx());
    expect(r.content).toContain('killed by');
  });

  it('truncates oversized output', async () => {
    const t = createBashTool({ maxOutputBytes: 100 });
    const r = await t.run({ command: 'printf "x%.0s" {1..500}' }, ctx());
    expect(r.content).toContain('truncated');
    expect(r.meta?.truncated).toBe(true);
  });
});

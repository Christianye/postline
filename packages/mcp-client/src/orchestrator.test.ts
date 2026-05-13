import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as clientMod from './client.js';
import type { McpClientHandle } from './client.js';
import { createMcpTools } from './orchestrator.js';

function makeHandle(
  partial: Partial<McpClientHandle> & { name: string; tools: McpClientHandle['tools'] },
): McpClientHandle {
  return {
    capabilities: { tools: true, resources: false, prompts: false },
    call: vi.fn(async () => ({ text: 'ok', isError: false })),
    listResources: vi.fn(async () => ({ resources: [] })),
    readResource: vi.fn(async () => ({ text: '', skipped: 0 })),
    close: vi.fn(async () => void 0),
    ...partial,
  };
}

describe('createMcpTools', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'postline-mcp-orch-'));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('returns empty bundle when no sources yield servers', async () => {
    const missingClaude = join(tmp, 'no.json');
    const bundle = await createMcpTools({ source: 'both', claudeConfigPath: missingClaude });
    expect(bundle.tools).toEqual([]);
    expect(bundle.handles).toEqual([]);
    expect(bundle.health).toEqual([]);
  });

  it('adapts every tool of every server into Tool[]', async () => {
    vi.spyOn(clientMod, 'spawnMcpServer').mockImplementation(async (name) =>
      makeHandle({
        name,
        tools: [
          { name: 'op_a', inputSchema: { type: 'object' } },
          { name: 'op_b', inputSchema: { type: 'object' } },
        ],
      }),
    );
    const bundle = await createMcpTools({
      servers: { demo: { command: 'x' } },
      source: 'postline',
      riskDefault: 'write',
    });
    expect(bundle.tools.map((t) => t.name).sort()).toEqual(['mcp_demo_op_a', 'mcp_demo_op_b']);
    expect(bundle.tools.every((t) => t.risk === 'write')).toBe(true);
    expect(bundle.health).toEqual([
      { name: 'demo', ok: true, toolCount: 2, hasResources: false, hasPrompts: false },
    ]);
  });

  it('applies per-tool risk overrides', async () => {
    vi.spyOn(clientMod, 'spawnMcpServer').mockImplementation(async (name) =>
      makeHandle({
        name,
        tools: [
          { name: 'read_thing', inputSchema: { type: 'object' } },
          { name: 'write_thing', inputSchema: { type: 'object' } },
        ],
      }),
    );
    const bundle = await createMcpTools({
      servers: { demo: { command: 'x' } },
      source: 'postline',
      riskDefault: 'dangerous',
      riskOverrides: { mcp_demo_read_thing: 'read' },
    });
    const byName = Object.fromEntries(bundle.tools.map((t) => [t.name, t.risk]));
    expect(byName.mcp_demo_read_thing).toBe('read');
    expect(byName.mcp_demo_write_thing).toBe('dangerous');
  });

  it('logs and skips a failing server by default', async () => {
    vi.spyOn(clientMod, 'spawnMcpServer').mockImplementation(async (name) => {
      if (name === 'broken') throw new Error('spawn failed');
      return makeHandle({ name, tools: [{ name: 'op', inputSchema: { type: 'object' } }] });
    });
    const warn = vi.fn();
    const bundle = await createMcpTools({
      servers: { broken: { command: 'x' }, good: { command: 'y' } },
      source: 'postline',
      logger: { warn },
    });
    expect(bundle.health.find((h) => h.name === 'broken')?.ok).toBe(false);
    expect(bundle.health.find((h) => h.name === 'good')?.ok).toBe(true);
    expect(bundle.tools.map((t) => t.name)).toEqual(['mcp_good_op']);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ server: 'broken' }),
      'mcp_server_failed',
    );
  });

  it('strict=true throws on failure and tears down other handles', async () => {
    const closeFn = vi.fn(async () => void 0);
    vi.spyOn(clientMod, 'spawnMcpServer').mockImplementation(async (name) => {
      if (name === 'later-broken') throw new Error('bad');
      return makeHandle({
        name,
        tools: [{ name: 'op', inputSchema: { type: 'object' } }],
        close: closeFn,
      });
    });
    await expect(
      createMcpTools({
        servers: { good: { command: 'x' }, 'later-broken': { command: 'y' } },
        source: 'postline',
        strict: true,
      }),
    ).rejects.toThrow(/bad/);
    expect(closeFn).toHaveBeenCalled();
  });

  it('registers resources_list + resources_read tools when server advertises resources', async () => {
    vi.spyOn(clientMod, 'spawnMcpServer').mockImplementation(async (name) =>
      makeHandle({
        name,
        tools: [{ name: 'op', inputSchema: { type: 'object' } }],
        capabilities: { tools: true, resources: true, prompts: false },
      }),
    );
    const bundle = await createMcpTools({
      servers: { docs: { command: 'x' } },
      source: 'postline',
    });
    const names = bundle.tools.map((t) => t.name).sort();
    expect(names).toEqual(['mcp_docs_op', 'mcp_docs_resources_list', 'mcp_docs_resources_read']);
    const listTool = bundle.tools.find((t) => t.name === 'mcp_docs_resources_list');
    expect(listTool?.risk).toBe('read');
    expect(bundle.health[0]?.hasResources).toBe(true);
    expect(bundle.health[0]?.hasPrompts).toBe(false);
  });

  it('does NOT register resources tools when capability is absent', async () => {
    vi.spyOn(clientMod, 'spawnMcpServer').mockImplementation(async (name) =>
      makeHandle({
        name,
        tools: [{ name: 'op', inputSchema: { type: 'object' } }],
        capabilities: { tools: true, resources: false, prompts: false },
      }),
    );
    const bundle = await createMcpTools({
      servers: { docs: { command: 'x' } },
      source: 'postline',
    });
    expect(bundle.tools.map((t) => t.name)).toEqual(['mcp_docs_op']);
  });

  it('shutdown() closes every handle', async () => {
    const closes: Array<ReturnType<typeof vi.fn>> = [];
    vi.spyOn(clientMod, 'spawnMcpServer').mockImplementation(async (name) => {
      const c = vi.fn(async () => void 0);
      closes.push(c);
      return makeHandle({
        name,
        tools: [{ name: 'op', inputSchema: { type: 'object' } }],
        close: c,
      });
    });
    const bundle = await createMcpTools({
      servers: { a: { command: 'x' }, b: { command: 'y' } },
      source: 'postline',
    });
    await bundle.shutdown();
    expect(closes.length).toBe(2);
    for (const c of closes) expect(c).toHaveBeenCalled();
  });
});

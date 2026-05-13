import type { Logger, ToolContext } from '@postline/core';
import { describe, expect, it, vi } from 'vitest';
import type { McpClientHandle } from './client.js';
import {
  adaptMcpTool,
  adaptResourcesListTool,
  adaptResourcesReadTool,
  buildToolName,
} from './tool-adapter.js';

function silentLogger(): Logger {
  const noop = () => void 0;
  const logger: Logger = {
    info: noop,
    warn: noop,
    error: noop,
    debug: noop,
    child: () => logger,
  };
  return logger;
}

function makeCtx(): ToolContext {
  return {
    userId: 'ou_test',
    conversationId: 'oc_test',
    log: silentLogger(),
    signal: new AbortController().signal,
  };
}

describe('buildToolName', () => {
  it('prefixes with mcp_ and joins server + tool', () => {
    expect(buildToolName('fs', 'read_file')).toBe('mcp_fs_read_file');
  });

  it('sanitises illegal chars to underscore', () => {
    expect(buildToolName('lark-docs', 'doc.read')).toBe('mcp_lark_docs_doc_read');
  });
});

function fullHandle(partial: Partial<McpClientHandle> & { name: string }): McpClientHandle {
  return {
    tools: [],
    capabilities: { tools: true, resources: false, prompts: false },
    call: vi.fn(async (name, _args) => ({ text: `ran ${name}`, isError: false })),
    listResources: vi.fn(async () => ({ resources: [] })),
    readResource: vi.fn(async () => ({ text: '', skipped: 0 })),
    close: vi.fn(async () => void 0),
    ...partial,
  };
}

describe('adaptMcpTool', () => {
  function makeHandle(tools: McpClientHandle['tools']): McpClientHandle {
    return fullHandle({ name: 'fs', tools });
  }

  it('throws if tool name not on server', () => {
    const handle = makeHandle([]);
    expect(() => adaptMcpTool(handle, 'missing', 'dangerous')).toThrow(/not found on server fs/);
  });

  it('applies the requested risk tier', () => {
    const handle = makeHandle([{ name: 'read_file', inputSchema: { type: 'object' } }]);
    const tool = adaptMcpTool(handle, 'read_file', 'read');
    expect(tool.risk).toBe('read');
  });

  it('patches inputSchema missing type=object', () => {
    const handle = makeHandle([{ name: 'read_file', inputSchema: { properties: {} } }]);
    const tool = adaptMcpTool(handle, 'read_file', 'dangerous');
    expect(tool.inputSchema.type).toBe('object');
  });

  it('prefixes description with [mcp:<server>]', () => {
    const handle = makeHandle([
      { name: 'read_file', inputSchema: { type: 'object' }, description: 'Read a file' },
    ]);
    const tool = adaptMcpTool(handle, 'read_file', 'dangerous');
    expect(tool.description).toBe('[mcp:fs] Read a file');
  });

  it('forwards args to handle.call and returns result', async () => {
    const handle = makeHandle([{ name: 'read_file', inputSchema: { type: 'object' } }]);
    const tool = adaptMcpTool(handle, 'read_file', 'dangerous');
    const result = await tool.run({ path: '/tmp/x' }, makeCtx());
    expect(handle.call).toHaveBeenCalledWith('read_file', { path: '/tmp/x' }, undefined);
    expect(result.content).toBe('ran read_file');
    expect(result.isError).toBe(false);
  });

  it('converts call errors into tool error results', async () => {
    const handle = fullHandle({
      name: 'fs',
      tools: [{ name: 'read_file', inputSchema: { type: 'object' } }],
      call: vi.fn(async () => {
        throw new Error('boom');
      }),
    });
    const tool = adaptMcpTool(handle, 'read_file', 'dangerous');
    const result = await tool.run({}, makeCtx());
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/mcp error: boom/);
  });
});

describe('adaptResourcesListTool', () => {
  it('names the tool mcp_<server>_resources_list with read risk', () => {
    const handle = fullHandle({ name: 'fs' });
    const tool = adaptResourcesListTool(handle);
    expect(tool.name).toBe('mcp_fs_resources_list');
    expect(tool.risk).toBe('read');
  });

  it('formats resources with uri, name, mime, description', async () => {
    const handle = fullHandle({
      name: 'fs',
      listResources: vi.fn(async () => ({
        resources: [
          { uri: 'file:///a', name: 'A', mimeType: 'text/plain', description: 'first' },
          { uri: 'file:///b' },
        ],
      })),
    });
    const tool = adaptResourcesListTool(handle);
    const result = await tool.run({}, makeCtx());
    expect(result.isError).toBe(false);
    expect(result.content).toContain('2 resource(s)');
    expect(result.content).toContain('file:///a A (text/plain) — first');
    expect(result.content).toContain('file:///b');
  });

  it('truncates at 100 entries and advertises pagination', async () => {
    const many = Array.from({ length: 150 }, (_, i) => ({ uri: `u://${i}` }));
    const handle = fullHandle({
      name: 'fs',
      listResources: vi.fn(async () => ({ resources: many, nextCursor: 'tok' })),
    });
    const tool = adaptResourcesListTool(handle);
    const result = await tool.run({}, makeCtx());
    expect(result.content).toContain('Showing first 100 of 150');
    expect(result.content).toContain('nextCursor: tok');
    expect(result.meta?.nextCursor).toBe('tok');
  });

  it('forwards cursor to handle.listResources', async () => {
    const listFn = vi.fn(async () => ({ resources: [] }));
    const handle = fullHandle({ name: 'fs', listResources: listFn });
    const tool = adaptResourcesListTool(handle);
    await tool.run({ cursor: 'page2' }, makeCtx());
    expect(listFn).toHaveBeenCalledWith('page2', undefined);
  });

  it('returns error result when listResources throws', async () => {
    const handle = fullHandle({
      name: 'fs',
      listResources: vi.fn(async () => {
        throw new Error('no perms');
      }),
    });
    const tool = adaptResourcesListTool(handle);
    const result = await tool.run({}, makeCtx());
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/mcp error: no perms/);
  });
});

describe('adaptResourcesReadTool', () => {
  it('names the tool mcp_<server>_resources_read with read risk', () => {
    const handle = fullHandle({ name: 'fs' });
    const tool = adaptResourcesReadTool(handle);
    expect(tool.name).toBe('mcp_fs_resources_read');
    expect(tool.risk).toBe('read');
  });

  it('requires uri arg', async () => {
    const handle = fullHandle({ name: 'fs' });
    const tool = adaptResourcesReadTool(handle);
    const result = await tool.run({}, makeCtx());
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/uri is required/);
  });

  it('returns concatenated text and skipped count in meta', async () => {
    const handle = fullHandle({
      name: 'fs',
      readResource: vi.fn(async () => ({
        text: 'hello\n[unsupported content type: image/png]',
        skipped: 1,
      })),
    });
    const tool = adaptResourcesReadTool(handle);
    const result = await tool.run({ uri: 'file:///x' }, makeCtx());
    expect(result.isError).toBe(false);
    expect(result.content).toContain('hello');
    expect(result.meta?.skipped).toBe(1);
  });
});

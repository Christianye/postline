import type { Logger, ToolContext } from '@postline/core';
import { describe, expect, it, vi } from 'vitest';
import type { McpClientHandle } from './client.js';
import { adaptMcpTool, buildToolName } from './tool-adapter.js';

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

describe('adaptMcpTool', () => {
  function makeHandle(tools: McpClientHandle['tools']): McpClientHandle {
    return {
      name: 'fs',
      tools,
      call: vi.fn(async (name, _args) => ({
        text: `ran ${name}`,
        isError: false,
      })),
      close: vi.fn(async () => void 0),
    };
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
    const handle: McpClientHandle = {
      name: 'fs',
      tools: [{ name: 'read_file', inputSchema: { type: 'object' } }],
      call: vi.fn(async () => {
        throw new Error('boom');
      }),
      close: vi.fn(async () => void 0),
    };
    const tool = adaptMcpTool(handle, 'read_file', 'dangerous');
    const result = await tool.run({}, makeCtx());
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/mcp error: boom/);
  });
});

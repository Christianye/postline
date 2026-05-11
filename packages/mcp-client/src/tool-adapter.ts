import type { Tool, ToolContext, ToolResult, ToolRisk } from '@postline/core';
import type { McpClientHandle } from './client.js';

/**
 * Wrap a single MCP tool exposed by `handle` into a postline Tool.
 * Postline-visible name: `mcp_<serverName>_<mcpToolName>`.
 */
export function adaptMcpTool(
  handle: McpClientHandle,
  mcpToolName: string,
  risk: ToolRisk,
  options: { callTimeoutMs?: number } = {},
): Tool {
  const mcpTool = handle.tools.find((t) => t.name === mcpToolName);
  if (!mcpTool) {
    throw new Error(`mcp: tool ${mcpToolName} not found on server ${handle.name}`);
  }
  const postlineName = buildToolName(handle.name, mcpToolName);
  const description = buildDescription(handle.name, mcpTool.description);
  const schema = normaliseSchema(mcpTool.inputSchema);

  return {
    name: postlineName,
    description,
    inputSchema: schema,
    risk,
    async run(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
      ctx.log.debug({ mcp_server: handle.name, mcp_tool: mcpToolName }, 'mcp_tool_call');
      try {
        const { text, isError } = await handle.call(mcpToolName, args, options.callTimeoutMs);
        return { content: text, isError, meta: { mcpServer: handle.name, mcpTool: mcpToolName } };
      } catch (err) {
        const msg = (err as Error).message ?? String(err);
        return { content: `mcp error: ${msg}`, isError: true };
      }
    },
  };
}

/**
 * Postline tool name: `mcp_<server>_<tool>`. The registry enforces uniqueness
 * across all loaded tools, and the provider layer treats `_` and alnum as
 * safe identifier chars for Anthropic / Bedrock tool-use.
 */
export function buildToolName(serverName: string, toolName: string): string {
  const clean = (s: string) => s.replace(/[^a-zA-Z0-9_]/g, '_');
  return `mcp_${clean(serverName)}_${clean(toolName)}`;
}

function buildDescription(serverName: string, original: string | undefined): string {
  const prefix = `[mcp:${serverName}] `;
  if (!original || original.length === 0) return `${prefix}(no description)`;
  return prefix + original;
}

/**
 * MCP tools may declare schemas missing the top-level `type: 'object'`. Claude
 * tool-use requires one. We patch, without rewriting the shape.
 */
function normaliseSchema(schema: Record<string, unknown>): Record<string, unknown> {
  if (!schema || typeof schema !== 'object') return { type: 'object', properties: {} };
  if (schema.type === undefined) {
    return { ...schema, type: 'object' };
  }
  return schema;
}

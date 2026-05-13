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

const RESOURCES_LIST_PAGE_CAP = 100;

/**
 * Synthetic tool that lets the model enumerate resources exposed by an MCP
 * server. Risk `read` — it only inspects metadata. Large servers are
 * truncated to the first 100 entries per page; set `cursor` to paginate.
 */
export function adaptResourcesListTool(
  handle: McpClientHandle,
  options: { callTimeoutMs?: number } = {},
): Tool {
  const name = `mcp_${sanitise(handle.name)}_resources_list`;
  return {
    name,
    description: `[mcp:${handle.name}] List resources exposed by the server. Returns uri, name, description, mimeType. Use mcp_${sanitise(handle.name)}_resources_read to fetch one.`,
    inputSchema: {
      type: 'object',
      properties: {
        cursor: {
          type: 'string',
          description: 'Pagination cursor returned by a previous call. Omit for the first page.',
        },
      },
    },
    risk: 'read',
    async run(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
      ctx.log.debug({ mcp_server: handle.name }, 'mcp_resources_list');
      const cursor = typeof args.cursor === 'string' ? args.cursor : undefined;
      try {
        const { resources, nextCursor } = await handle.listResources(cursor, options.callTimeoutMs);
        const truncated = resources.length > RESOURCES_LIST_PAGE_CAP;
        const shown = truncated ? resources.slice(0, RESOURCES_LIST_PAGE_CAP) : resources;
        const header = truncated
          ? `Showing first ${RESOURCES_LIST_PAGE_CAP} of ${resources.length}; rerun with cursor to page.`
          : `${resources.length} resource(s).`;
        const lines = shown.map((r) => {
          const bits = [r.uri];
          if (r.name) bits.push(r.name);
          if (r.mimeType) bits.push(`(${r.mimeType})`);
          if (r.description) bits.push(`— ${r.description}`);
          return bits.join(' ');
        });
        const footer = nextCursor ? `\nnextCursor: ${nextCursor}` : '';
        return {
          content: [header, ...lines].join('\n') + footer,
          isError: false,
          meta: {
            mcpServer: handle.name,
            count: resources.length,
            ...(nextCursor ? { nextCursor } : {}),
          },
        };
      } catch (err) {
        return { content: `mcp error: ${(err as Error).message}`, isError: true };
      }
    },
  };
}

/**
 * Synthetic tool that reads a single resource by URI. Risk `read` — reads
 * are always safe in the MCP model. Non-text content parts (blob / image)
 * are rendered as `[unsupported content type: <mime>]` markers.
 */
export function adaptResourcesReadTool(
  handle: McpClientHandle,
  options: { callTimeoutMs?: number } = {},
): Tool {
  const name = `mcp_${sanitise(handle.name)}_resources_read`;
  return {
    name,
    description: `[mcp:${handle.name}] Read one resource by URI. Use mcp_${sanitise(handle.name)}_resources_list first to discover URIs.`,
    inputSchema: {
      type: 'object',
      properties: {
        uri: {
          type: 'string',
          description: 'Resource URI, e.g. "file:///…" or server-specific scheme.',
        },
      },
      required: ['uri'],
    },
    risk: 'read',
    async run(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
      const uri = typeof args.uri === 'string' ? args.uri : '';
      if (!uri) {
        return { content: 'mcp error: uri is required', isError: true };
      }
      ctx.log.debug({ mcp_server: handle.name, uri }, 'mcp_resources_read');
      try {
        const { text, skipped } = await handle.readResource(uri, options.callTimeoutMs);
        return {
          content: text,
          isError: false,
          meta: { mcpServer: handle.name, uri, ...(skipped > 0 ? { skipped } : {}) },
        };
      } catch (err) {
        return { content: `mcp error: ${(err as Error).message}`, isError: true };
      }
    },
  };
}

function sanitise(s: string): string {
  return s.replace(/[^a-zA-Z0-9_]/g, '_');
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

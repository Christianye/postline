import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { McpServerConfig } from './types.js';

export interface McpTool {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

export interface McpClientHandle {
  /** Server name as declared in mcpServers config. */
  name: string;
  /** Tools discovered on the server. */
  tools: McpTool[];
  /** Call a tool by its MCP name (not the postline-prefixed name). */
  call(toolName: string, args: Record<string, unknown>, timeoutMs?: number): Promise<CallResult>;
  /** Shut the subprocess down. Idempotent. */
  close(): Promise<void>;
}

export interface CallResult {
  text: string;
  isError: boolean;
}

/**
 * Spawn one stdio MCP server, do the initialize handshake, list its tools, and
 * return a handle. Throws if the handshake fails or tools/list errors.
 *
 * Caller owns the handle lifecycle — must call close() on shutdown.
 */
export async function spawnMcpServer(
  name: string,
  cfg: McpServerConfig,
  opts: { connectTimeoutMs?: number } = {},
): Promise<McpClientHandle> {
  const connectTimeoutMs = opts.connectTimeoutMs ?? 10_000;

  const env = resolveEnv(cfg.env);
  const transport = new StdioClientTransport({
    command: cfg.command,
    args: cfg.args ? [...cfg.args] : [],
    ...(env ? { env } : {}),
    ...(cfg.cwd ? { cwd: cfg.cwd } : {}),
  });

  const client = new Client({ name: 'postline', version: '0.1.0' }, { capabilities: {} });

  await withTimeout(client.connect(transport), connectTimeoutMs, `mcp connect (${name})`);

  const listed = await withTimeout(client.listTools(), connectTimeoutMs, `mcp listTools (${name})`);

  const tools: McpTool[] = (listed.tools ?? []).map((t) => ({
    name: t.name,
    ...(t.description ? { description: t.description } : {}),
    inputSchema: (t.inputSchema ?? {}) as Record<string, unknown>,
  }));

  let closed = false;
  const handle: McpClientHandle = {
    name,
    tools,
    async call(toolName, args, timeoutMs) {
      const ms = timeoutMs ?? 60_000;
      const resp = await withTimeout(
        client.callTool({ name: toolName, arguments: args }),
        ms,
        `mcp callTool ${name}/${toolName}`,
      );
      return formatCallResult(resp);
    },
    async close() {
      if (closed) return;
      closed = true;
      try {
        await client.close();
      } catch {
        // best-effort
      }
    },
  };
  return handle;
}

function resolveEnv(
  src: Readonly<Record<string, string | undefined>> | undefined,
): Record<string, string> | undefined {
  if (!src) return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(src)) {
    if (typeof v === 'string') out[k] = v;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function formatCallResult(resp: unknown): CallResult {
  const r = resp as {
    isError?: boolean;
    content?: Array<{ type: string; text?: string; [k: string]: unknown }>;
  };
  const parts: string[] = [];
  for (const c of r.content ?? []) {
    if (c.type === 'text' && typeof c.text === 'string') {
      parts.push(c.text);
    } else {
      parts.push(`[unsupported content type: ${c.type}]`);
    }
  }
  return {
    text: parts.join('\n'),
    isError: Boolean(r.isError),
  };
}

async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    timer.unref();
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

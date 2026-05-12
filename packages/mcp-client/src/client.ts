import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { McpServerConfig } from './types.js';

// Structural shape we only need for `client.connect(transport)`. The SDK's
// exported `Transport` interface has exactOptionalPropertyTypes trouble with
// the concrete transport classes, so we use the minimal subset we actually
// care about — enough for `Client.connect()` to accept it at the call site.
type AnyTransport = unknown;

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

  const transport = buildTransport(cfg);

  const client = new Client({ name: 'postline', version: '0.1.4' }, { capabilities: {} });

  // biome-ignore lint/suspicious/noExplicitAny: transport union type variance — see note at AnyTransport
  await withTimeout(client.connect(transport as any), connectTimeoutMs, `mcp connect (${name})`);

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

function buildTransport(cfg: McpServerConfig): AnyTransport {
  const type = cfg.type ?? 'stdio';
  switch (type) {
    case 'stdio': {
      const stdio = cfg as Extract<McpServerConfig, { command: string }>;
      const env = resolveEnv(stdio.env);
      return new StdioClientTransport({
        command: stdio.command,
        args: stdio.args ? [...stdio.args] : [],
        ...(env ? { env } : {}),
        ...(stdio.cwd ? { cwd: stdio.cwd } : {}),
      });
    }
    case 'http':
    case 'streamable-http': {
      const http = cfg as Extract<McpServerConfig, { type: 'http' | 'streamable-http' }>;
      return new StreamableHTTPClientTransport(new URL(http.url), {
        ...(http.headers ? { requestInit: { headers: { ...http.headers } } } : {}),
      });
    }
    case 'sse': {
      const sse = cfg as Extract<McpServerConfig, { type: 'sse' }>;
      return new SSEClientTransport(new URL(sse.url), {
        ...(sse.headers ? { requestInit: { headers: { ...sse.headers } } } : {}),
      });
    }
    default: {
      const _exhaustive: never = type as never;
      throw new Error(`mcp: unknown transport type ${JSON.stringify(_exhaustive)}`);
    }
  }
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

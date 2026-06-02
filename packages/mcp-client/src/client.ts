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

export interface McpResource {
  uri: string;
  name?: string;
  description?: string;
  mimeType?: string;
}

export interface McpPromptArgument {
  name: string;
  description?: string;
  required?: boolean;
}

export interface McpPrompt {
  name: string;
  description?: string;
  arguments?: McpPromptArgument[];
}

export interface McpServerCapabilities {
  tools: boolean;
  resources: boolean;
  prompts: boolean;
}

export interface McpClientHandle {
  /** Server name as declared in mcpServers config. */
  name: string;
  /** Tools discovered on the server. */
  tools: McpTool[];
  /** What the server advertises in its handshake. `false` means the surface isn't supported. */
  capabilities: McpServerCapabilities;
  /** Call a tool by its MCP name (not the postline-prefixed name). */
  call(toolName: string, args: Record<string, unknown>, timeoutMs?: number): Promise<CallResult>;
  /** List resources exposed by the server. Only valid when capabilities.resources is true. */
  listResources(cursor?: string, timeoutMs?: number): Promise<ListResourcesResult>;
  /** Read a single resource by URI. Only valid when capabilities.resources is true. */
  readResource(uri: string, timeoutMs?: number): Promise<ReadResourceResult>;
  /** List prompts exposed by the server. Only valid when capabilities.prompts is true. */
  listPrompts(cursor?: string, timeoutMs?: number): Promise<ListPromptsResult>;
  /** Render a prompt with arguments. Only valid when capabilities.prompts is true. */
  getPrompt(
    name: string,
    args?: Record<string, string>,
    timeoutMs?: number,
  ): Promise<GetPromptResult>;
  /** Shut the subprocess down. Idempotent. */
  close(): Promise<void>;
}

export interface ListResourcesResult {
  resources: McpResource[];
  nextCursor?: string;
}

export interface ListPromptsResult {
  prompts: McpPrompt[];
  nextCursor?: string;
}

export interface GetPromptResult {
  /**
   * Rendered transcript: each PromptMessage becomes one line `<role>: <text>`.
   * Non-text content parts render as `[unsupported content type: <mime>]`.
   */
  text: string;
  /** Optional human-readable description returned by the server. */
  description?: string;
  /** Total messages in the prompt (text + non-text). */
  messageCount: number;
  /** Count of non-text content parts replaced with placeholders. */
  skipped: number;
}

export interface ReadResourceResult {
  /**
   * Concatenated text representation of every `text`-shaped content part.
   * Non-text parts (e.g. blob) are rendered as `[unsupported content type: <mime>]`
   * markers to keep the tool contract string-shaped.
   */
  text: string;
  /** Count of non-text parts skipped. */
  skipped: number;
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

  const client = new Client({ name: 'postline', version: '0.3.0' }, { capabilities: {} });

  // biome-ignore lint/suspicious/noExplicitAny: transport union type variance — see note at AnyTransport
  await withTimeout(client.connect(transport as any), connectTimeoutMs, `mcp connect (${name})`);

  const serverCaps = client.getServerCapabilities() ?? {};
  const capabilities: McpServerCapabilities = {
    tools: Boolean(serverCaps.tools),
    resources: Boolean(serverCaps.resources),
    prompts: Boolean(serverCaps.prompts),
  };

  const tools: McpTool[] = capabilities.tools
    ? (
        await withTimeout(client.listTools(), connectTimeoutMs, `mcp listTools (${name})`)
      ).tools.map((t) => ({
        name: t.name,
        ...(t.description ? { description: t.description } : {}),
        inputSchema: (t.inputSchema ?? {}) as Record<string, unknown>,
      }))
    : [];

  let closed = false;
  const handle: McpClientHandle = {
    name,
    tools,
    capabilities,
    async call(toolName, args, timeoutMs) {
      const ms = timeoutMs ?? 60_000;
      const resp = await withTimeout(
        client.callTool({ name: toolName, arguments: args }),
        ms,
        `mcp callTool ${name}/${toolName}`,
      );
      return formatCallResult(resp);
    },
    async listResources(cursor, timeoutMs) {
      if (!capabilities.resources) {
        throw new Error(`mcp: server ${name} does not advertise resources capability`);
      }
      const ms = timeoutMs ?? 60_000;
      const resp = await withTimeout(
        client.listResources(cursor ? { cursor } : undefined),
        ms,
        `mcp listResources (${name})`,
      );
      return {
        resources: (resp.resources ?? []).map((r) => ({
          uri: r.uri,
          ...(r.name ? { name: r.name } : {}),
          ...(r.description ? { description: r.description } : {}),
          ...(r.mimeType ? { mimeType: r.mimeType } : {}),
        })),
        ...(resp.nextCursor ? { nextCursor: resp.nextCursor } : {}),
      };
    },
    async readResource(uri, timeoutMs) {
      if (!capabilities.resources) {
        throw new Error(`mcp: server ${name} does not advertise resources capability`);
      }
      const ms = timeoutMs ?? 60_000;
      const resp = await withTimeout(
        client.readResource({ uri }),
        ms,
        `mcp readResource ${name}/${uri}`,
      );
      return formatResourceContents(resp);
    },
    async listPrompts(cursor, timeoutMs) {
      if (!capabilities.prompts) {
        throw new Error(`mcp: server ${name} does not advertise prompts capability`);
      }
      const ms = timeoutMs ?? 60_000;
      const resp = await withTimeout(
        client.listPrompts(cursor ? { cursor } : undefined),
        ms,
        `mcp listPrompts (${name})`,
      );
      return {
        prompts: (resp.prompts ?? []).map((p) => ({
          name: p.name,
          ...(p.description ? { description: p.description } : {}),
          ...(p.arguments
            ? {
                arguments: p.arguments.map((a) => ({
                  name: a.name,
                  ...(a.description ? { description: a.description } : {}),
                  ...(a.required !== undefined ? { required: Boolean(a.required) } : {}),
                })),
              }
            : {}),
        })),
        ...(resp.nextCursor ? { nextCursor: resp.nextCursor } : {}),
      };
    },
    async getPrompt(promptName, args, timeoutMs) {
      if (!capabilities.prompts) {
        throw new Error(`mcp: server ${name} does not advertise prompts capability`);
      }
      const ms = timeoutMs ?? 60_000;
      const resp = await withTimeout(
        client.getPrompt({ name: promptName, ...(args ? { arguments: args } : {}) }),
        ms,
        `mcp getPrompt ${name}/${promptName}`,
      );
      return formatPromptMessages(resp);
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

function formatResourceContents(resp: unknown): ReadResourceResult {
  const r = resp as {
    contents?: Array<{ uri?: string; mimeType?: string; text?: string; blob?: string }>;
  };
  const parts: string[] = [];
  let skipped = 0;
  for (const c of r.contents ?? []) {
    if (typeof c.text === 'string') {
      parts.push(c.text);
    } else {
      skipped += 1;
      parts.push(`[unsupported content type: ${c.mimeType ?? 'unknown'}]`);
    }
  }
  return { text: parts.join('\n'), skipped };
}

function formatPromptMessages(resp: unknown): GetPromptResult {
  const r = resp as {
    description?: string;
    messages?: Array<{
      role?: string;
      content?: { type?: string; text?: string; mimeType?: string; [k: string]: unknown };
    }>;
  };
  const messages = r.messages ?? [];
  const lines: string[] = [];
  let skipped = 0;
  for (const m of messages) {
    const role = m.role ?? 'user';
    const c = m.content ?? {};
    if (c.type === 'text' && typeof c.text === 'string') {
      lines.push(`${role}: ${c.text}`);
    } else {
      skipped += 1;
      lines.push(`${role}: [unsupported content type: ${c.mimeType ?? c.type ?? 'unknown'}]`);
    }
  }
  return {
    text: lines.join('\n\n'),
    ...(r.description ? { description: r.description } : {}),
    messageCount: messages.length,
    skipped,
  };
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

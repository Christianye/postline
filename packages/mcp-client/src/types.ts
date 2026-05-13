import type { ToolRisk } from '@postline/core';

/**
 * Per-server config. Three transport shapes, discriminated by `type`:
 *   - 'stdio'          (default) — spawn a subprocess, talk over stdio.
 *     Shape matches Claude Code / Claude Desktop's `mcpServers` entries.
 *   - 'http' or 'streamable-http' — connect to a Streamable HTTP MCP server.
 *   - 'sse'            — legacy Server-Sent Events transport.
 *
 * For MVP, auth over HTTP/SSE is header-based only (`headers: {...}`). OAuth
 * flows (deferred to the roadmap) would go through the SDK's `authProvider`.
 */
export type McpServerConfig = McpStdioServerConfig | McpHttpServerConfig | McpSseServerConfig;

export interface McpStdioServerConfig {
  /** Defaults to 'stdio' if omitted. */
  type?: 'stdio';
  /** Executable to spawn. */
  command: string;
  /** Arguments. */
  args?: readonly string[];
  /** Env vars to inject. Values resolving to undefined are skipped. */
  env?: Readonly<Record<string, string | undefined>>;
  /** Current working directory for the spawned process. */
  cwd?: string;
}

export interface McpHttpServerConfig {
  type: 'http' | 'streamable-http';
  /** Server endpoint, e.g. `https://mcp.example.com/v1`. */
  url: string;
  /** Optional request headers (e.g. `{ Authorization: 'Bearer ...' }`). */
  headers?: Readonly<Record<string, string>>;
}

export interface McpSseServerConfig {
  type: 'sse';
  /** SSE endpoint URL. */
  url: string;
  /** Optional request headers applied to both POST + SSE requests. */
  headers?: Readonly<Record<string, string>>;
}

/**
 * Where to source MCP server definitions from.
 *  - 'postline'    → only the servers you wrote into postline.config.ts (`tools.options.mcp.servers`)
 *  - 'claude-code' → only servers in ~/.claude.json → mcpServers
 *  - 'both'        → merge; postline config wins on name conflict (default)
 */
export type McpSource = 'postline' | 'claude-code' | 'both';

export interface McpToolsOptions {
  /** Where to source server configs. Default 'both'. */
  source?: McpSource;
  /** Inline server definitions — takes precedence on name conflict. */
  servers?: Readonly<Record<string, McpServerConfig>>;
  /** Default risk tier applied to every MCP tool. Default 'dangerous'. */
  riskDefault?: ToolRisk;
  /**
   * Per-tool risk overrides keyed by the postline-visible tool name
   * (`mcp_<serverName>_<mcpToolName>`). Useful to drop a known read-only tool
   * to 'read' so it skips the /approve gate.
   */
  riskOverrides?: Readonly<Record<string, ToolRisk>>;
  /** Path to Claude Code config. Default `${HOME}/.claude.json`. */
  claudeConfigPath?: string;
  /** Connect timeout per server in ms. Default 10000. */
  connectTimeoutMs?: number;
  /** Per-tool-call timeout in ms. Default 60000. */
  callTimeoutMs?: number;
  /**
   * If true, a single failing server aborts tool construction. Default false
   * (fail-open: log the failure, keep the others).
   */
  strict?: boolean;
}

export interface McpHealth {
  name: string;
  ok: boolean;
  toolCount: number;
  /** Whether the server advertises the `resources` capability. Undefined if never handshook. */
  hasResources?: boolean;
  /** Whether the server advertises the `prompts` capability. Undefined if never handshook. */
  hasPrompts?: boolean;
  error?: string;
}

import type { Tool, ToolRisk } from '@postline/core';
import { type McpClientHandle, spawnMcpServer } from './client.js';
import { resolveServers } from './config-loader.js';
import { adaptMcpTool, buildToolName } from './tool-adapter.js';
import type { McpHealth, McpToolsOptions } from './types.js';

export interface CreatedMcp {
  tools: Tool[];
  handles: McpClientHandle[];
  /** Per-server health report — useful for doctor / startup logs. */
  health: McpHealth[];
  /** Shut every handle down. Idempotent. */
  shutdown(): Promise<void>;
}

/**
 * Resolve configured MCP servers, spawn each, list+adapt their tools.
 * Returns a bundle of tools (to pass to the turn runner), handles (for
 * lifecycle management), and health (for doctor).
 *
 * Fail-open by default: a server that can't start is logged and skipped,
 * unless `opts.strict` is set.
 */
export async function createMcpTools(
  opts: McpToolsOptions & { logger?: { warn: (o: object, msg: string) => void } } = {},
): Promise<CreatedMcp> {
  const servers = await resolveServers({
    ...(opts.source !== undefined ? { source: opts.source } : {}),
    ...(opts.servers !== undefined ? { servers: opts.servers } : {}),
    ...(opts.claudeConfigPath !== undefined ? { claudeConfigPath: opts.claudeConfigPath } : {}),
  });
  const riskDefault: ToolRisk = opts.riskDefault ?? 'dangerous';
  const overrides = opts.riskOverrides ?? {};

  const tools: Tool[] = [];
  const handles: McpClientHandle[] = [];
  const health: McpHealth[] = [];

  for (const [name, cfg] of Object.entries(servers)) {
    try {
      const spawnOpts: { connectTimeoutMs?: number } = {};
      if (opts.connectTimeoutMs !== undefined) spawnOpts.connectTimeoutMs = opts.connectTimeoutMs;
      const handle = await spawnMcpServer(name, cfg, spawnOpts);
      handles.push(handle);
      health.push({ name, ok: true, toolCount: handle.tools.length });

      for (const t of handle.tools) {
        const postlineName = buildToolName(name, t.name);
        const risk = overrides[postlineName] ?? riskDefault;
        const adapterOpts: { callTimeoutMs?: number } = {};
        if (opts.callTimeoutMs !== undefined) adapterOpts.callTimeoutMs = opts.callTimeoutMs;
        tools.push(adaptMcpTool(handle, t.name, risk, adapterOpts));
      }
    } catch (err) {
      const msg = (err as Error).message ?? String(err);
      health.push({ name, ok: false, toolCount: 0, error: msg });
      opts.logger?.warn({ server: name, err: msg }, 'mcp_server_failed');
      if (opts.strict) {
        // best-effort shutdown of anything we already spawned
        await shutdownAll(handles);
        throw err;
      }
    }
  }

  return {
    tools,
    handles,
    health,
    async shutdown() {
      await shutdownAll(handles);
    },
  };
}

async function shutdownAll(handles: McpClientHandle[]): Promise<void> {
  await Promise.all(handles.map((h) => h.close().catch(() => void 0)));
}

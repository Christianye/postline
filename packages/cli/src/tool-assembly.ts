import type { PostlineConfig } from '@postline/config';
import type { Logger, Tool } from '@postline/core';
import { type CreatedMcp, createMcpTools } from '@postline/mcp-client';
import { type ToolBuildContext, createBuiltinTools } from '@postline/tools-builtin';

/**
 * Assemble every tool the turn runner needs: built-in tools plus (optionally)
 * MCP-sourced ones. Returns both the Map for runTurn and the MCP handle so the
 * caller can shut subprocesses down on exit.
 */
export async function assembleTools(
  cfg: PostlineConfig,
  ctx: ToolBuildContext,
  log: Logger,
): Promise<{ tools: Map<string, Tool>; mcp: CreatedMcp | undefined }> {
  const tools = new Map<string, Tool>();

  for (const t of createBuiltinTools(cfg.tools.builtin, cfg.tools.options ?? {}, ctx)) {
    tools.set(t.name, t);
  }

  let mcp: CreatedMcp | undefined;
  if (cfg.tools.mcp) {
    mcp = await createMcpTools({
      ...cfg.tools.mcp,
      logger: { warn: (o, msg) => log.warn(o, msg) },
    });
    for (const t of mcp.tools) {
      if (tools.has(t.name)) {
        log.warn({ tool: t.name }, 'mcp_tool_name_collision_skipped');
        continue;
      }
      tools.set(t.name, t);
    }
    log.info({ servers: mcp.health.length, toolsAdded: mcp.tools.length }, 'mcp_tools_loaded');
  }

  return { tools, mcp };
}

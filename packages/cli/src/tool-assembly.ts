import type { PostlineConfig } from '@postline/config';
import type { Logger, Tool } from '@postline/core';
import { type CreatedMcp, createMcpTools } from '@postline/mcp-client';
import { createSkillTools } from '@postline/skill-loader';
import { type ToolBuildContext, createBuiltinTools } from '@postline/tools-builtin';

/**
 * Assemble every tool the turn runner needs: built-in tools plus (optionally)
 * MCP-sourced ones and Claude Code skills. Returns the Map for runTurn, the
 * MCP handle (for subprocess shutdown), and the optional system-prompt
 * fragment that advertises loaded skills.
 */
export async function assembleTools(
  cfg: PostlineConfig,
  ctx: ToolBuildContext,
  log: Logger,
): Promise<{
  tools: Map<string, Tool>;
  mcp: CreatedMcp | undefined;
  systemPromptSuffix: string;
}> {
  const tools = new Map<string, Tool>();
  let systemPromptSuffix = '';

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

  const skillsCfg = cfg.tools.skills;
  if (skillsCfg?.enabled) {
    const { enabled: _enabled, ...loaderOpts } = skillsCfg;
    const skillBundle = await createSkillTools({
      ...loaderOpts,
      onWarn: (msg) => log.warn({ msg }, 'skill_loader_warning'),
    });
    for (const t of skillBundle.tools) {
      if (tools.has(t.name)) {
        log.warn({ tool: t.name }, 'skill_tool_name_collision_skipped');
        continue;
      }
      tools.set(t.name, t);
    }
    systemPromptSuffix = skillBundle.systemPromptFragment;
    log.info(
      { skills: skillBundle.skills.length, advertised: systemPromptSuffix ? 'yes' : 'no' },
      'skills_loaded',
    );
  }

  return { tools, mcp, systemPromptSuffix };
}

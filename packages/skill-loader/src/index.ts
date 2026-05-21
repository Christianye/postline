export { discoverSkills } from './discover.js';
export { adaptSkillTool, buildSkillToolName, buildSkillsSystemFragment } from './adapter.js';
export { splitFrontmatter } from './frontmatter.js';
export { createSkillRunTool } from './skill-runner.js';
export type { SkillRunOptions } from './skill-runner.js';
export type { Skill, SkillLoaderOptions } from './types.js';

import type { Tool } from '@postline/core';
import { adaptSkillTool, buildSkillToolName, buildSkillsSystemFragment } from './adapter.js';
import { discoverSkills } from './discover.js';
import { type SkillRunOptions, createSkillRunTool } from './skill-runner.js';
import type { Skill, SkillLoaderOptions } from './types.js';

/**
 * One-shot orchestrator: discover → adapt. Returns everything the CLI needs.
 *
 * Use this from tool-assembly.ts; it is the only entry the rest of the
 * codebase needs to know about.
 */
export async function createSkillTools(
  opts: SkillLoaderOptions & {
    onWarn?: (msg: string) => void;
    /** Tuning for the global `skill_run` tool. Ignored if no skill ships scripts/. */
    runOptions?: SkillRunOptions;
  } = {},
): Promise<{
  skills: Skill[];
  tools: Tool[];
  systemPromptFragment: string;
}> {
  const skills = await discoverSkills(opts);

  // Detect tool-name collisions inside the skill set before we register.
  // Two skill ids that differ only in punctuation sanitise to the same
  // postline tool name (e.g. `aws-html-slides` vs `aws_html_slides`). The
  // first wins; subsequent ones are skipped with a warning.
  const seen = new Map<string, string>();
  const accepted: Skill[] = [];
  for (const skill of skills) {
    const toolName = buildSkillToolName(skill.id);
    const prev = seen.get(toolName);
    if (prev) {
      opts.onWarn?.(
        `skill-loader: skill id '${skill.id}' collides with '${prev}' on tool name '${toolName}', skipping`,
      );
      continue;
    }
    seen.set(toolName, skill.id);
    accepted.push(skill);
  }

  const tools: Tool[] = accepted.map(adaptSkillTool);

  // The global skill_run tool is registered iff at least one accepted skill
  // ships a scripts/ subdir. No skills with scripts → no tool, so the model
  // never sees an option that would always reject.
  if (accepted.some((s) => s.hasScripts)) {
    tools.push(createSkillRunTool(accepted, opts.runOptions));
  }

  const systemPromptFragment = buildSkillsSystemFragment(accepted);
  return { skills: accepted, tools, systemPromptFragment };
}

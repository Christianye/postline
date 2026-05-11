export { discoverSkills } from './discover.js';
export { adaptSkillTool, buildSkillToolName, buildSkillsSystemFragment } from './adapter.js';
export { splitFrontmatter } from './frontmatter.js';
export type { Skill, SkillLoaderOptions } from './types.js';

import type { Tool } from '@postline/core';
import { adaptSkillTool, buildSkillsSystemFragment } from './adapter.js';
import { discoverSkills } from './discover.js';
import type { Skill, SkillLoaderOptions } from './types.js';

/**
 * One-shot orchestrator: discover → adapt. Returns everything the CLI needs.
 *
 * Use this from tool-assembly.ts; it is the only entry the rest of the
 * codebase needs to know about.
 */
export async function createSkillTools(
  opts: SkillLoaderOptions & { onWarn?: (msg: string) => void } = {},
): Promise<{
  skills: Skill[];
  tools: Tool[];
  systemPromptFragment: string;
}> {
  const skills = await discoverSkills(opts);
  const tools = skills.map(adaptSkillTool);
  const systemPromptFragment = buildSkillsSystemFragment(skills);
  return { skills, tools, systemPromptFragment };
}

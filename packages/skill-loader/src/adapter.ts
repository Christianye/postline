import type { Tool, ToolContext, ToolResult } from '@postline/core';
import type { Skill } from './types.js';

/**
 * Build a postline Tool that, when called, returns the skill's instructional
 * body. The model is expected to then follow those instructions within the
 * same turn — often using other tools (bash_read, fs_read, git-aware calls)
 * that the skill's markdown mentions.
 *
 * Risk is always `read`: the skill tool itself has no side effect — it just
 * returns text. The model might subsequently invoke tools WITH side effects,
 * but those are gated by their own risk tier.
 *
 * Tool name: `skill_<id-with-dashes-replaced>`.
 */
export function adaptSkillTool(skill: Skill): Tool {
  const name = buildSkillToolName(skill.id);

  return {
    name,
    description: `Load the "${skill.name}" skill. ${skill.description}`.trim(),
    inputSchema: {
      type: 'object',
      properties: {
        prompt: {
          type: 'string',
          description:
            'What you want to do using this skill (optional — the skill guide will be returned either way).',
        },
      },
      additionalProperties: false,
    },
    risk: 'read',
    async run(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
      const userPrompt = typeof args.prompt === 'string' ? args.prompt : '';
      ctx.log.debug({ skill: skill.id }, 'skill_tool_invoked');

      // `meta.skill` is for host-side telemetry (turn log + audit trail).
      // The model never sees it — only `content` flows back into the turn.
      return { content: renderSkillContent(skill, userPrompt), meta: { skill: skill.id } };
    },
  };
}

/**
 * Render the text returned to the model when a skill tool is invoked.
 * Kept as a standalone function so tests can snapshot it and so the
 * format is one pass of `.join` rather than three concatenations.
 */
function renderSkillContent(skill: Skill, userPrompt: string): string {
  const sections: string[] = [
    `# Skill: ${skill.name}`,
    skill.description,
    '---',
    "Follow the guide below to complete the user's request. You may call other tools (bash_read, fs_read, git-backed memory, etc.) as the guide suggests. Stay within the risk-tier limits of those tools — this skill tool is read-only text.",
    '---',
  ];
  if (userPrompt) sections.push(`**User prompt**: ${userPrompt}`);
  sections.push(skill.body);
  return sections.join('\n\n');
}

/**
 * Build the postline-visible tool name from a skill id. Non-alnum/underscore
 * characters are replaced with `_`, which means two different directory names
 * (e.g. `aws-html-slides` vs. `aws_html_slides`) can collide on the same
 * output. The orchestrator (createSkillTools) detects and warns on collisions
 * — callers should not need to.
 */
export function buildSkillToolName(id: string): string {
  const clean = id.replace(/[^a-zA-Z0-9_]/g, '_');
  return `skill_${clean}`;
}

/**
 * Build the "Available skills" fragment to inject into the system prompt.
 * Skills flagged `disable-model-invocation: true` are omitted — they stay
 * callable but un-advertised.
 *
 * Returns an empty string if no skills are advertised. The caller should
 * detect and skip the injection in that case.
 */
export function buildSkillsSystemFragment(skills: readonly Skill[]): string {
  const advertised = skills.filter((s) => !s.disableModelInvocation);
  if (advertised.length === 0) return '';

  const lines = advertised.map((s) => `- **${buildSkillToolName(s.id)}** — ${s.description}`);

  return [
    '',
    '',
    '## Available skills',
    '',
    "You have access to the following skill tools. Each returns a step-by-step guide when called. Invoke one via its `skill_*` tool when the user's request matches the skill's description, then follow the guide.",
    '',
    lines.join('\n'),
  ].join('\n');
}

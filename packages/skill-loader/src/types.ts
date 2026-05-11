/**
 * Parsed shape of one Claude Code skill.
 *
 * On disk:
 *   ~/.claude/skills/<name>/SKILL.md
 *
 * SKILL.md has YAML-ish frontmatter (same subset Claude Code uses):
 *   ---
 *   name: commit-smart
 *   description: one-line hook shown to the model
 *   disable-model-invocation: true   # optional; default false
 *   ---
 *   # body (markdown)
 */
export interface Skill {
  /** Skill directory name (not necessarily === frontmatter.name). */
  id: string;
  /** frontmatter.name if present, else id. */
  name: string;
  /** frontmatter.description — shown to the model in the "Available skills" prompt fragment. */
  description: string;
  /**
   * If true, postline does NOT advertise this skill in the system prompt.
   * The skill_<name> tool is still registered so the operator can call it
   * explicitly, but the model won't be told it exists.
   */
  disableModelInvocation: boolean;
  /** Raw SKILL.md body (everything after the frontmatter). */
  body: string;
  /** Absolute path to SKILL.md. */
  path: string;
}

export interface SkillLoaderOptions {
  /** Directory to walk. Default `${HOME}/.claude/skills`. */
  dir?: string;
  /**
   * If true, a malformed SKILL.md aborts loading. Default false — malformed
   * skills are logged and skipped so one broken file doesn't hide the rest.
   */
  strict?: boolean;
  /** Optional filter: only load these skill ids. Empty/undefined = all. */
  include?: readonly string[];
  /** Optional filter: skip these skill ids. */
  exclude?: readonly string[];
}

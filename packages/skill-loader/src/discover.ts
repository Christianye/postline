import { readFile, readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { splitFrontmatter } from './frontmatter.js';
import type { Skill, SkillLoaderOptions } from './types.js';

/**
 * Walk `dir` (default ~/.claude/skills), parse each SKILL.md it finds, return
 * the parsed Skill[]. Missing dir → [] (not an error).
 *
 * Malformed skills (no frontmatter name, unreadable file) are logged via
 * options.onWarn if provided and skipped; strict=true bubbles the error.
 */
export async function discoverSkills(
  opts: SkillLoaderOptions & { onWarn?: (msg: string) => void } = {},
): Promise<Skill[]> {
  const dir = opts.dir ?? join(homedir(), '.claude', 'skills');
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }

  const include = new Set(opts.include ?? []);
  const exclude = new Set(opts.exclude ?? []);
  const results: Skill[] = [];

  for (const id of entries) {
    if (include.size > 0 && !include.has(id)) continue;
    if (exclude.has(id)) continue;

    const skillDir = join(dir, id);
    try {
      const s = await stat(skillDir);
      if (!s.isDirectory()) continue;
    } catch {
      continue;
    }

    const skillPath = join(skillDir, 'SKILL.md');
    let raw: string;
    try {
      raw = await readFile(skillPath, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue; // not a skill dir
      if (opts.strict) throw err;
      opts.onWarn?.(`skill-loader: cannot read ${skillPath}: ${(err as Error).message}`);
      continue;
    }

    const scriptsDir = join(skillDir, 'scripts');
    let hasScripts = false;
    try {
      const ss = await stat(scriptsDir);
      hasScripts = ss.isDirectory();
    } catch {
      hasScripts = false;
    }

    try {
      const parsed = parseSkill(id, skillPath, raw, hasScripts, scriptsDir);
      if (!parsed.description) {
        if (opts.strict) {
          throw new Error(`skill ${id}: frontmatter.description is required`);
        }
        opts.onWarn?.(`skill-loader: ${id} has no description in frontmatter, skipping`);
        continue;
      }
      results.push(parsed);
    } catch (err) {
      if (opts.strict) throw err;
      opts.onWarn?.(`skill-loader: cannot parse ${skillPath}: ${(err as Error).message}`);
    }
  }

  // Sort for stable order — easier to reason about in tests and logs.
  results.sort((a, b) => a.id.localeCompare(b.id));
  return results;
}

function parseSkill(
  id: string,
  path: string,
  raw: string,
  hasScripts: boolean,
  scriptsDir: string,
): Skill {
  const { frontmatter, body } = splitFrontmatter(raw);
  const name = coerceString(frontmatter.name) ?? id;
  const description = coerceString(frontmatter.description) ?? '';
  const disableModelInvocation = frontmatter['disable-model-invocation'] === true;

  return {
    id,
    name,
    description,
    disableModelInvocation,
    body,
    path,
    hasScripts,
    ...(hasScripts ? { scriptsDir } : {}),
  };
}

function coerceString(v: unknown): string | undefined {
  if (typeof v === 'string' && v.length > 0) return v;
  return undefined;
}

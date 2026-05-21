import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createSkillTools } from './index.js';

describe('createSkillTools', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'postline-skill-orch-'));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  function writeSkill(id: string, content: string): void {
    const d = join(tmp, id);
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, 'SKILL.md'), content);
  }

  it('returns empty bundle when no skills found', async () => {
    const bundle = await createSkillTools({ dir: tmp });
    expect(bundle.skills).toEqual([]);
    expect(bundle.tools).toEqual([]);
    expect(bundle.systemPromptFragment).toBe('');
  });

  it('adapts every discovered skill', async () => {
    writeSkill('review', '---\nname: review\ndescription: code review\n---\nbody');
    writeSkill('test-gen', '---\nname: test-gen\ndescription: generate tests\n---\nbody');
    const bundle = await createSkillTools({ dir: tmp });
    expect(bundle.tools.map((t) => t.name).sort()).toEqual(['skill_review', 'skill_test_gen']);
    expect(bundle.systemPromptFragment).toContain('skill_review');
    expect(bundle.systemPromptFragment).toContain('skill_test_gen');
  });

  it('registers skill_run when at least one skill ships scripts/', async () => {
    writeSkill('hasit', '---\nname: hasit\ndescription: has scripts\n---\nbody');
    mkdirSync(join(tmp, 'hasit', 'scripts'));
    writeSkill('plain', '---\nname: plain\ndescription: just text\n---\nbody');
    const bundle = await createSkillTools({ dir: tmp });
    expect(bundle.tools.map((t) => t.name).sort()).toEqual([
      'skill_hasit',
      'skill_plain',
      'skill_run',
    ]);
  });

  it('does NOT register skill_run when no skill ships scripts/', async () => {
    writeSkill('a', '---\nname: a\ndescription: d\n---\nbody');
    writeSkill('b', '---\nname: b\ndescription: d\n---\nbody');
    const bundle = await createSkillTools({ dir: tmp });
    expect(bundle.tools.map((t) => t.name).sort()).toEqual(['skill_a', 'skill_b']);
  });

  it('system fragment annotates skills that ship scripts/', async () => {
    writeSkill('hasit', '---\nname: hasit\ndescription: has scripts\n---\nbody');
    mkdirSync(join(tmp, 'hasit', 'scripts'));
    writeSkill('plain', '---\nname: plain\ndescription: just text\n---\nbody');
    const bundle = await createSkillTools({ dir: tmp });
    expect(bundle.systemPromptFragment).toContain('skill_hasit');
    expect(bundle.systemPromptFragment).toMatch(/skill_hasit.*scripts\/.*skill_run/s);
    // plain has no scripts/, so its line should not mention skill_run
    const plainLine = bundle.systemPromptFragment
      .split('\n')
      .find((l) => l.includes('skill_plain')) as string;
    expect(plainLine).toBeDefined();
    expect(plainLine).not.toContain('skill_run');
  });

  it('detects tool-name collisions and keeps the first, warns on the rest', async () => {
    // Both sanitise to `skill_aws_html_slides`. discoverSkills returns results
    // sorted by id (localeCompare: `-` before `_`), so `aws-html-slides` wins.
    writeSkill('aws-html-slides', '---\nname: dash\ndescription: dashy\n---\nbody');
    writeSkill('aws_html_slides', '---\nname: under\ndescription: undery\n---\nbody');
    const warnings: string[] = [];
    const bundle = await createSkillTools({ dir: tmp, onWarn: (m) => warnings.push(m) });
    expect(bundle.tools.map((t) => t.name)).toEqual(['skill_aws_html_slides']);
    expect(bundle.skills).toHaveLength(1);
    const winner = bundle.skills[0]?.id;
    expect(['aws-html-slides', 'aws_html_slides']).toContain(winner);
    const loser = winner === 'aws-html-slides' ? 'aws_html_slides' : 'aws-html-slides';
    expect(warnings.some((w) => /collides/.test(w) && w.includes(loser))).toBe(true);
  });
});

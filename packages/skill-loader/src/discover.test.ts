import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { discoverSkills } from './discover.js';

describe('discoverSkills', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'postline-skill-'));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  function writeSkill(id: string, content: string): void {
    const d = join(tmp, id);
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, 'SKILL.md'), content);
  }

  it('returns [] when dir does not exist', async () => {
    const result = await discoverSkills({ dir: join(tmp, 'nope') });
    expect(result).toEqual([]);
  });

  it('returns [] when dir is empty', async () => {
    const result = await discoverSkills({ dir: tmp });
    expect(result).toEqual([]);
  });

  it('parses one well-formed skill', async () => {
    writeSkill(
      'commit-smart',
      `---
name: commit-smart
description: Smart conventional commits
---
# Guide
do stuff`,
    );
    const result = await discoverSkills({ dir: tmp });
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      id: 'commit-smart',
      name: 'commit-smart',
      description: 'Smart conventional commits',
      disableModelInvocation: false,
    });
    expect(result[0]?.body).toContain('# Guide');
  });

  it('respects disable-model-invocation flag', async () => {
    writeSkill(
      'hidden',
      `---
name: hidden
description: Not for model
disable-model-invocation: true
---
body`,
    );
    const result = await discoverSkills({ dir: tmp });
    expect(result[0]?.disableModelInvocation).toBe(true);
  });

  it('skips directories without SKILL.md', async () => {
    mkdirSync(join(tmp, 'not-a-skill'));
    writeFileSync(join(tmp, 'not-a-skill', 'README.md'), 'hi');
    writeSkill('real', '---\nname: real\ndescription: d\n---\nbody');
    const result = await discoverSkills({ dir: tmp });
    expect(result.map((s) => s.id)).toEqual(['real']);
  });

  it('skips skills without description by default, warns', async () => {
    writeSkill('broken', '---\nname: broken\n---\nbody');
    const warnings: string[] = [];
    const result = await discoverSkills({ dir: tmp, onWarn: (m) => warnings.push(m) });
    expect(result).toEqual([]);
    expect(warnings.some((w) => /no description/.test(w))).toBe(true);
  });

  it('strict=true throws on missing description', async () => {
    writeSkill('broken', '---\nname: broken\n---\nbody');
    await expect(discoverSkills({ dir: tmp, strict: true })).rejects.toThrow(
      /description is required/,
    );
  });

  it('honours include filter', async () => {
    writeSkill('a', '---\nname: a\ndescription: d\n---\n');
    writeSkill('b', '---\nname: b\ndescription: d\n---\n');
    writeSkill('c', '---\nname: c\ndescription: d\n---\n');
    const result = await discoverSkills({ dir: tmp, include: ['a', 'c'] });
    expect(result.map((s) => s.id)).toEqual(['a', 'c']);
  });

  it('honours exclude filter', async () => {
    writeSkill('a', '---\nname: a\ndescription: d\n---\n');
    writeSkill('b', '---\nname: b\ndescription: d\n---\n');
    const result = await discoverSkills({ dir: tmp, exclude: ['b'] });
    expect(result.map((s) => s.id)).toEqual(['a']);
  });

  it('returns results sorted by id', async () => {
    writeSkill('z-skill', '---\nname: z\ndescription: d\n---\n');
    writeSkill('a-skill', '---\nname: a\ndescription: d\n---\n');
    writeSkill('m-skill', '---\nname: m\ndescription: d\n---\n');
    const result = await discoverSkills({ dir: tmp });
    expect(result.map((s) => s.id)).toEqual(['a-skill', 'm-skill', 'z-skill']);
  });
});

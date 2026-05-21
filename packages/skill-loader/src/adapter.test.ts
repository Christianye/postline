import type { Logger, ToolContext } from '@postline/core';
import { describe, expect, it } from 'vitest';
import { adaptSkillTool, buildSkillToolName, buildSkillsSystemFragment } from './adapter.js';
import type { Skill } from './types.js';

function makeSkill(partial: Partial<Skill> = {}): Skill {
  return {
    id: 'demo',
    name: 'demo',
    description: 'demo skill',
    disableModelInvocation: false,
    body: '# Body\n\n1. step one\n2. step two',
    path: '/tmp/demo/SKILL.md',
    hasScripts: false,
    ...partial,
  };
}

function silentLogger(): Logger {
  const noop = () => void 0;
  const logger: Logger = {
    info: noop,
    warn: noop,
    error: noop,
    debug: noop,
    child: () => logger,
  };
  return logger;
}

function makeCtx(): ToolContext {
  return {
    userId: 'ou_test',
    conversationId: 'oc_test',
    log: silentLogger(),
    signal: new AbortController().signal,
  };
}

describe('buildSkillToolName', () => {
  it('prefixes skill_ and preserves underscores/alnums', () => {
    expect(buildSkillToolName('commit_smart')).toBe('skill_commit_smart');
  });

  it('sanitises dashes and dots to underscore', () => {
    expect(buildSkillToolName('aws-html-slides')).toBe('skill_aws_html_slides');
    expect(buildSkillToolName('web.fetch.v2')).toBe('skill_web_fetch_v2');
  });
});

describe('adaptSkillTool', () => {
  it('returns a read-risk tool named skill_<id>', () => {
    const tool = adaptSkillTool(makeSkill({ id: 'commit-smart' }));
    expect(tool.name).toBe('skill_commit_smart');
    expect(tool.risk).toBe('read');
  });

  it('exposes optional prompt in input schema with additionalProperties off', () => {
    const tool = adaptSkillTool(makeSkill());
    expect(tool.inputSchema).toMatchObject({
      type: 'object',
      properties: { prompt: { type: 'string' } },
      additionalProperties: false,
    });
  });

  it('returns skill body + header on invocation', async () => {
    const tool = adaptSkillTool(makeSkill({ body: 'run X then Y' }));
    const result = await tool.run({}, makeCtx());
    expect(result.content).toContain('# Skill: demo');
    expect(result.content).toContain('run X then Y');
    expect(result.isError).toBeFalsy();
  });

  it('includes user prompt when passed', async () => {
    const tool = adaptSkillTool(makeSkill());
    const result = await tool.run({ prompt: 'review recent commits' }, makeCtx());
    expect(result.content).toContain('**User prompt**: review recent commits');
  });

  it('ignores non-string prompt argument', async () => {
    const tool = adaptSkillTool(makeSkill());
    const result = await tool.run({ prompt: 42 as unknown as string }, makeCtx());
    expect(result.content).not.toContain('42');
  });
});

describe('buildSkillsSystemFragment', () => {
  it('returns empty string when no skills advertised', () => {
    expect(buildSkillsSystemFragment([])).toBe('');
  });

  it('lists advertised skills with tool name + description', () => {
    const frag = buildSkillsSystemFragment([
      makeSkill({ id: 'commit-smart', description: 'smart commits' }),
      makeSkill({ id: 'review', description: 'deep code review' }),
    ]);
    expect(frag).toContain('## Available skills');
    expect(frag).toContain('skill_commit_smart');
    expect(frag).toContain('smart commits');
    expect(frag).toContain('skill_review');
  });

  it('hides disable-model-invocation skills from the fragment', () => {
    const frag = buildSkillsSystemFragment([
      makeSkill({ id: 'public', description: 'see me' }),
      makeSkill({ id: 'hidden', description: 'stay quiet', disableModelInvocation: true }),
    ]);
    expect(frag).toContain('skill_public');
    expect(frag).not.toContain('skill_hidden');
  });

  it('returns empty when every skill is hidden', () => {
    const frag = buildSkillsSystemFragment([
      makeSkill({ id: 'a', disableModelInvocation: true }),
      makeSkill({ id: 'b', disableModelInvocation: true }),
    ]);
    expect(frag).toBe('');
  });

  it('annotates skills that ship scripts/ with a skill_run hint', () => {
    const frag = buildSkillsSystemFragment([
      makeSkill({ id: 'pdf', description: 'pdf tools', hasScripts: true }),
      makeSkill({ id: 'plain', description: 'just text' }),
    ]);
    const pdfLine = frag.split('\n').find((l) => l.includes('skill_pdf')) as string;
    const plainLine = frag.split('\n').find((l) => l.includes('skill_plain')) as string;
    expect(pdfLine).toContain('scripts/');
    expect(pdfLine).toContain('skill_run');
    expect(plainLine).not.toContain('skill_run');
  });
});

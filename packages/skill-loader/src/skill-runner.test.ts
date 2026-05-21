import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Logger, ToolContext } from '@postline/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createSkillRunTool } from './skill-runner.js';
import type { Skill } from './types.js';

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

function makeCtx(signal?: AbortSignal): ToolContext {
  return {
    userId: 'ou_test',
    conversationId: 'oc_test',
    log: silentLogger(),
    signal: signal ?? new AbortController().signal,
  };
}

function writeExecScript(path: string, body: string): void {
  writeFileSync(path, body);
  chmodSync(path, 0o755);
}

describe('createSkillRunTool', () => {
  let tmp: string;
  let scriptsDir: string;
  let skill: Skill;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'postline-skill-run-'));
    scriptsDir = join(tmp, 'demo', 'scripts');
    mkdirSync(scriptsDir, { recursive: true });
    skill = {
      id: 'demo',
      name: 'demo',
      description: 'demo skill',
      disableModelInvocation: false,
      body: '',
      path: join(tmp, 'demo', 'SKILL.md'),
      hasScripts: true,
      scriptsDir,
    };
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('exposes a write-tier tool named skill_run', () => {
    const tool = createSkillRunTool([skill]);
    expect(tool.name).toBe('skill_run');
    expect(tool.risk).toBe('write');
  });

  it('description lists known skills with scripts/', () => {
    const tool = createSkillRunTool([skill]);
    expect(tool.description).toContain('demo');
    expect(tool.description).toContain('demo skill');
  });

  it('description handles the empty case', () => {
    const tool = createSkillRunTool([]);
    expect(tool.description).toContain('No skills with scripts/');
  });

  it('rejects unknown skill id', async () => {
    const tool = createSkillRunTool([skill]);
    const result = await tool.run({ skill: 'ghost', script: 'x.sh' }, makeCtx());
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/unknown skill 'ghost'/);
  });

  it('rejects skills without scripts/', async () => {
    const noScripts: Skill = { ...skill, hasScripts: false };
    delete (noScripts as { scriptsDir?: string }).scriptsDir;
    const tool = createSkillRunTool([noScripts]);
    const result = await tool.run({ skill: 'demo', script: 'x.sh' }, makeCtx());
    expect(result.isError).toBe(true);
  });

  it('rejects path traversal via ../', async () => {
    writeExecScript(join(tmp, 'demo', 'naughty.sh'), '#!/bin/sh\necho pwned\n');
    const tool = createSkillRunTool([skill]);
    const result = await tool.run({ skill: 'demo', script: '../naughty.sh' }, makeCtx());
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/outside the skill's scripts\/ directory/);
  });

  it('rejects symlink that points outside scripts/', async () => {
    writeExecScript(join(tmp, 'demo', 'naughty.sh'), '#!/bin/sh\necho pwned\n');
    symlinkSync(join(tmp, 'demo', 'naughty.sh'), join(scriptsDir, 'link.sh'));
    const tool = createSkillRunTool([skill]);
    const result = await tool.run({ skill: 'demo', script: 'link.sh' }, makeCtx());
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/outside the skill's scripts\/ directory/);
  });

  it('rejects non-existent script', async () => {
    const tool = createSkillRunTool([skill]);
    const result = await tool.run({ skill: 'demo', script: 'missing.sh' }, makeCtx());
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/script not found/);
  });

  it('rejects non-executable file', async () => {
    const p = join(scriptsDir, 'noperm.sh');
    writeFileSync(p, '#!/bin/sh\necho hi\n');
    chmodSync(p, 0o644);
    const tool = createSkillRunTool([skill]);
    const result = await tool.run({ skill: 'demo', script: 'noperm.sh' }, makeCtx());
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/not executable/);
  });

  it('rejects when target is a directory, not a file', async () => {
    mkdirSync(join(scriptsDir, 'subdir'));
    const tool = createSkillRunTool([skill]);
    const result = await tool.run({ skill: 'demo', script: 'subdir' }, makeCtx());
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/not a regular file/);
  });

  it('runs a script and returns its stdout', async () => {
    writeExecScript(join(scriptsDir, 'hello.sh'), '#!/bin/sh\necho hello world\n');
    const tool = createSkillRunTool([skill]);
    const result = await tool.run({ skill: 'demo', script: 'hello.sh' }, makeCtx());
    expect(result.isError).toBeUndefined();
    expect(result.content).toContain('hello world');
    expect(result.content).toContain('[exit 0]');
    expect(result.meta?.exitCode).toBe(0);
  });

  it('forwards argv items verbatim (no shell expansion)', async () => {
    writeExecScript(
      join(scriptsDir, 'echo-args.sh'),
      '#!/bin/sh\nfor a in "$@"; do echo "[$a]"; done\n',
    );
    const tool = createSkillRunTool([skill]);
    const result = await tool.run(
      { skill: 'demo', script: 'echo-args.sh', args: ['hi there', '$HOME', '*'] },
      makeCtx(),
    );
    expect(result.content).toContain('[hi there]');
    expect(result.content).toContain('[$HOME]'); // literal, not expanded
    expect(result.content).toContain('[*]'); // literal, not globbed
  });

  it('marks isError=true when script exits non-zero', async () => {
    writeExecScript(join(scriptsDir, 'fail.sh'), '#!/bin/sh\necho oops >&2\nexit 7\n');
    const tool = createSkillRunTool([skill]);
    const result = await tool.run({ skill: 'demo', script: 'fail.sh' }, makeCtx());
    expect(result.isError).toBe(true);
    expect(result.content).toContain('oops');
    expect(result.content).toContain('[exit 7]');
    expect(result.meta?.exitCode).toBe(7);
  });

  it('scrubs env: AWS_SECRET_ACCESS_KEY etc are not visible to the script', async () => {
    writeExecScript(
      join(scriptsDir, 'envdump.sh'),
      '#!/bin/sh\nenv | grep -E "^(AWS_SECRET|ANTHROPIC|FEISHU|PATH|HOME)=" | sort\n',
    );
    const prevAws = process.env.AWS_SECRET_ACCESS_KEY;
    const prevAnth = process.env.ANTHROPIC_API_KEY;
    process.env.AWS_SECRET_ACCESS_KEY = 'AKIA-DO-NOT-LEAK';
    process.env.ANTHROPIC_API_KEY = 'sk-ant-do-not-leak';
    try {
      const tool = createSkillRunTool([skill]);
      const result = await tool.run({ skill: 'demo', script: 'envdump.sh' }, makeCtx());
      expect(result.content).not.toContain('DO-NOT-LEAK');
      expect(result.content).toMatch(/PATH=/);
    } finally {
      if (prevAws === undefined) delete process.env.AWS_SECRET_ACCESS_KEY;
      else process.env.AWS_SECRET_ACCESS_KEY = prevAws;
      if (prevAnth === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = prevAnth;
    }
  });

  it('runs in cwd = skill scriptsDir', async () => {
    writeExecScript(join(scriptsDir, 'pwd.sh'), '#!/bin/sh\npwd\n');
    const tool = createSkillRunTool([skill]);
    const result = await tool.run({ skill: 'demo', script: 'pwd.sh' }, makeCtx());
    // realpath of scriptsDir to handle macOS /var → /private/var symlink
    const { realpathSync } = await import('node:fs');
    expect(result.content).toContain(realpathSync(scriptsDir));
  });

  it('kills the process on timeout', async () => {
    writeExecScript(join(scriptsDir, 'sleep.sh'), '#!/bin/sh\nsleep 5\n');
    const tool = createSkillRunTool([skill]);
    const result = await tool.run(
      { skill: 'demo', script: 'sleep.sh', timeout_ms: 200 },
      makeCtx(),
    );
    expect(result.content).toMatch(/killed by SIG/);
    expect(result.meta?.signal).toBeTruthy();
  }, 10_000);

  it('kills the process when ctx.signal aborts', async () => {
    writeExecScript(join(scriptsDir, 'sleep.sh'), '#!/bin/sh\nsleep 5\n');
    const tool = createSkillRunTool([skill]);
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 100);
    const result = await tool.run({ skill: 'demo', script: 'sleep.sh' }, makeCtx(ac.signal));
    expect(result.content).toMatch(/killed by SIG/);
  }, 10_000);

  it('truncates stdout that exceeds the cap', async () => {
    // 200KB of output, cap at 4KB to keep the test fast.
    writeExecScript(join(scriptsDir, 'big.sh'), '#!/bin/sh\nyes x | head -c 200000\n');
    const tool = createSkillRunTool([skill], { maxOutputBytes: 4 * 1024 });
    const result = await tool.run({ skill: 'demo', script: 'big.sh' }, makeCtx());
    expect(result.content).toContain('[...truncated]');
    expect(result.meta?.truncated).toBe(true);
  });
});

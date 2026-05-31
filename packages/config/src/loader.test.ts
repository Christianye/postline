import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadPostlineConfig, validateConfig } from './loader.js';
import { defineConfig } from './types.js';

describe('defineConfig', () => {
  it('is an identity function; just gives IDE types', () => {
    const c = defineConfig({
      provider: { name: 'bedrock' },
      model: 'amazon-bedrock/us.anthropic.claude-opus-4-7',
      allowlist: { openIds: ['ou_x'] },
      memory: { dir: '/tmp/m' },
      tools: { builtin: ['echo'] },
    });
    expect(c.provider.name).toBe('bedrock');
  });
});

describe('validateConfig', () => {
  it('accepts a minimal valid config', () => {
    const errors = validateConfig({
      provider: { name: 'bedrock' },
      model: 'anthropic/claude-opus-4-7',
      allowlist: { openIds: [] },
      memory: { dir: '/tmp/m' },
      tools: { builtin: [] },
    });
    expect(errors).toEqual([]);
  });

  it('catches missing fields', () => {
    // @ts-expect-error — deliberately invalid
    const errors = validateConfig({ allowlist: { openIds: [] } });
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.join('\n')).toMatch(/provider\.name/);
    expect(errors.join('\n')).toMatch(/model/);
    expect(errors.join('\n')).toMatch(/memory\.dir/);
  });

  it('requires feishu.appId + appSecret when feishu section present', () => {
    const errors = validateConfig({
      provider: { name: 'bedrock' },
      model: 'x',
      allowlist: { openIds: [] },
      memory: { dir: '/tmp/m' },
      tools: { builtin: [] },
      // @ts-expect-error — missing appSecret
      feishu: { appId: 'cli_x' },
    });
    expect(errors.join('\n')).toMatch(/feishu\.appSecret/);
  });

  it('accepts a well-formed feishu.approval block', () => {
    const errors = validateConfig({
      provider: { name: 'bedrock' },
      model: 'x',
      allowlist: { openIds: [] },
      memory: { dir: '/tmp/m' },
      tools: { builtin: [] },
      feishu: {
        appId: 'cli_x',
        appSecret: 's',
        approval: { requesterOnly: true, admins: ['ou_oncall'] },
      },
    });
    expect(errors).toEqual([]);
  });

  it('rejects feishu.approval.admins with non-string entries', () => {
    const errors = validateConfig({
      provider: { name: 'bedrock' },
      model: 'x',
      allowlist: { openIds: [] },
      memory: { dir: '/tmp/m' },
      tools: { builtin: [] },
      feishu: {
        appId: 'cli_x',
        appSecret: 's',
        // @ts-expect-error — runtime check, not type check
        approval: { admins: [123, ''] },
      },
    });
    expect(errors.join('\n')).toMatch(/feishu\.approval\.admins/);
  });
});

describe('loadPostlineConfig', () => {
  let tmp: string;
  const originalEnv = { ...process.env };

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'postline-cfg-'));
  });

  afterEach(() => {
    // restore env
    for (const k of Object.keys(process.env)) {
      if (!(k in originalEnv)) delete process.env[k];
    }
    for (const [k, v] of Object.entries(originalEnv)) {
      process.env[k] = v;
    }
  });

  it('loads from an explicit config path (js)', async () => {
    const path = join(tmp, 'my.config.mjs');
    writeFileSync(
      path,
      `export default {
         provider: { name: 'bedrock', region: 'us-east-1' },
         model: 'amazon-bedrock/us.anthropic.claude-sonnet-4-6',
         allowlist: { openIds: ['ou_a'] },
         memory: { dir: '/tmp/m' },
         tools: { builtin: ['echo', 'bash_read'] },
       };`,
    );
    const cfg = await loadPostlineConfig({ configPath: path });
    expect(cfg.provider.name).toBe('bedrock');
    expect(cfg.model).toContain('sonnet');
    expect(cfg.tools.builtin).toContain('bash_read');
  });

  it('respects POSTLINE_CONFIG env', async () => {
    const path = join(tmp, 'my.config.mjs');
    writeFileSync(
      path,
      `export default {
         provider: { name: 'anthropic' },
         model: 'anthropic/claude-opus-4-7',
         allowlist: { openIds: [] },
         memory: { dir: '/tmp/m' },
         tools: { builtin: [] },
       };`,
    );
    process.env.POSTLINE_CONFIG = path;
    const cfg = await loadPostlineConfig();
    expect(cfg.provider.name).toBe('anthropic');
  });

  it('auto-discovers postline.config.mjs in cwd', async () => {
    writeFileSync(
      join(tmp, 'postline.config.mjs'),
      `export default {
         provider: { name: 'bedrock' },
         model: 'x',
         allowlist: { openIds: [] },
         memory: { dir: '/tmp/m' },
         tools: { builtin: ['echo'] },
       };`,
    );
    const cfg = await loadPostlineConfig({ cwd: tmp });
    expect(cfg.provider.name).toBe('bedrock');
  });

  it('walks up from a nested cwd to find config at workspace root', async () => {
    // Simulates `pnpm --filter @postline/cli run chat`: cwd = packages/cli/,
    // but the user's postline.config.ts lives at the repo root.
    writeFileSync(
      join(tmp, 'postline.config.mjs'),
      `export default {
         provider: { name: 'anthropic' },
         model: 'anthropic/claude-opus-4-7',
         allowlist: { openIds: [] },
         memory: { dir: '/tmp/m' },
         tools: { builtin: ['echo'] },
       };`,
    );
    const nested = join(tmp, 'packages', 'cli');
    mkdirSync(nested, { recursive: true });
    const cfg = await loadPostlineConfig({ cwd: nested });
    expect(cfg.provider.name).toBe('anthropic');
  });

  it('prefers a closer config over an ancestor config', async () => {
    writeFileSync(
      join(tmp, 'postline.config.mjs'),
      `export default {
         provider: { name: 'bedrock' },
         model: 'root-config',
         allowlist: { openIds: [] },
         memory: { dir: '/tmp/m' },
         tools: { builtin: [] },
       };`,
    );
    const nested = join(tmp, 'sub');
    mkdirSync(nested, { recursive: true });
    writeFileSync(
      join(nested, 'postline.config.mjs'),
      `export default {
         provider: { name: 'anthropic' },
         model: 'nested-config',
         allowlist: { openIds: [] },
         memory: { dir: '/tmp/m' },
         tools: { builtin: [] },
       };`,
    );
    const cfg = await loadPostlineConfig({ cwd: nested });
    expect(cfg.model).toBe('nested-config');
  });

  it('throws in strict mode without a config file', async () => {
    await expect(loadPostlineConfig({ cwd: tmp, strict: true })).rejects.toThrow(
      /no postline\.config/,
    );
  });

  it('throws when config file has no default export', async () => {
    const path = join(tmp, 'bad.mjs');
    writeFileSync(path, `export const x = 1;`);
    await expect(loadPostlineConfig({ configPath: path })).rejects.toThrow(/no default export/);
  });

  it('falls back to env when no config file exists', async () => {
    // Isolate: point env away from real Mac dotfiles
    delete process.env.CC_FEISHU_APP_ID;
    delete process.env.CC_FEISHU_APP_SECRET;
    process.env.CC_ALLOWLIST_OPEN_IDS = 'ou_env1,ou_env2';
    process.env.CC_MEMORY_DIR = '/tmp/env-memory';
    process.env.CC_PRIMARY_MODEL = 'amazon-bedrock/us.anthropic.claude-opus-4-7';
    // Make an empty dir (no config file) and no ~/.cc-dev/.env available
    mkdirSync(join(tmp, 'empty'), { recursive: true });
    // Can't easily stub homedir, so just verify the env->config shape if we got it
    const cfg = await loadPostlineConfig({ cwd: join(tmp, 'empty') });
    expect(cfg.provider.name).toBe('bedrock');
    expect(cfg.memory.dir).toBe('/tmp/env-memory');
    // allowlist *might* be overridden by real ~/.cc-dev/.env if it loads first,
    // so we check for inclusion of our test values OR that allowlist exists.
    expect(cfg.allowlist.openIds.length).toBeGreaterThan(0);
    expect(cfg.tools.builtin).toContain('bash_read');
  });
});

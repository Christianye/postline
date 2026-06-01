import type { PostlineConfig } from '@postline/config';
import { describe, expect, it } from 'vitest';
import { buildRuntimeStateSuffix } from './runtime-state.js';

function baseCfg(overrides: Partial<PostlineConfig> = {}): PostlineConfig {
  return {
    provider: { name: 'bedrock' },
    model: 'amazon-bedrock/us.anthropic.claude-opus-4-7',
    allowlist: { openIds: [] },
    memory: { dir: '/tmp/m' },
    tools: { builtin: [] },
    ...overrides,
  } as PostlineConfig;
}

describe('buildRuntimeStateSuffix', () => {
  it('includes pid + started_at + node + model', () => {
    const out = buildRuntimeStateSuffix(baseCfg());
    expect(out).toMatch(/pid: \d+/);
    // started_at is ISO without milliseconds: YYYY-MM-DDTHH:MM:SSZ
    expect(out).toMatch(/started_at: \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z/);
    expect(out).toContain(`node: ${process.version}`);
    expect(out).toContain('model: amazon-bedrock/us.anthropic.claude-opus-4-7');
  });

  it('reports thinking off when not configured', () => {
    const out = buildRuntimeStateSuffix(baseCfg());
    expect(out).toContain('thinking: off');
  });

  it('reports thinking on + effort when enabled', () => {
    const out = buildRuntimeStateSuffix(
      baseCfg({ inference: { thinking: { enabled: true, effort: 'high' } } }),
    );
    expect(out).toContain('thinking: on (effort=high)');
  });

  it('reports streaming + requesterOnly state from feishu config', () => {
    const out = buildRuntimeStateSuffix(
      baseCfg({
        feishu: {
          appId: 'cli_x',
          appSecret: 's',
          streaming: true,
          approval: { requesterOnly: false },
        },
      }),
    );
    expect(out).toContain('streaming: on');
    expect(out).toContain('requesterOnly: off');
  });

  it('defaults requesterOnly=on when feishu.approval is unset', () => {
    const out = buildRuntimeStateSuffix(baseCfg({ feishu: { appId: 'cli_x', appSecret: 's' } }));
    expect(out).toContain('requesterOnly: on');
  });

  it('git field is either a 12-char hex or "unknown"', () => {
    const out = buildRuntimeStateSuffix(baseCfg());
    expect(out).toMatch(/- git: ([0-9a-f]{12}|unknown)/);
  });

  it('appends bedrock-adaptive-thinking caveat when thinking enabled on bedrock', () => {
    const out = buildRuntimeStateSuffix(
      baseCfg({
        provider: { name: 'bedrock' },
        inference: { thinking: { enabled: true, effort: 'high' } },
      }),
    );
    expect(out).toContain('reasoning runs internally');
    expect(out).toContain('💭');
    expect(out).toContain('provider-side');
  });

  it('omits the caveat when thinking is off, even on bedrock', () => {
    const out = buildRuntimeStateSuffix(baseCfg({ provider: { name: 'bedrock' } }));
    expect(out).not.toContain('reasoning runs internally');
    expect(out).not.toContain('💭');
  });

  it('omits the caveat when thinking enabled but provider is not bedrock', () => {
    const out = buildRuntimeStateSuffix(
      baseCfg({
        provider: { name: 'anthropic' },
        inference: { thinking: { enabled: true, effort: 'high' } },
      }),
    );
    expect(out).not.toContain('reasoning runs internally');
  });

  it('output is stable for two calls within the same process tick', () => {
    // Within the same ms the started_at + git head + cfg snapshot all match,
    // so two synchronous builds should be byte-identical. Important because
    // we rely on the suffix being stable across turns for Anthropic prompt
    // cache hits.
    const cfg = baseCfg();
    const a = buildRuntimeStateSuffix(cfg);
    const b = buildRuntimeStateSuffix(cfg);
    // started_at granularity is seconds (we strip milliseconds), so unless
    // these run across a second boundary they're equal. Compare prefix up
    // to and including model — that part is fully deterministic per call.
    const prefix = (s: string) => s.split('\n').slice(0, 13).join('\n');
    expect(prefix(a)).toBe(prefix(b));
  });
});

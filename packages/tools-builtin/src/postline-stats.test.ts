import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type ToolContext, createLogger } from '@postline/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createPostlineStatsTool } from './postline-stats.js';

const log = createLogger({ level: 'silent' });
const ctx = (): ToolContext => ({
  userId: 'ou_me',
  conversationId: 'c',
  log,
  signal: new AbortController().signal,
});

describe('postline_stats tool', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'postline-stats-'));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('unknown action returns error', async () => {
    const t = createPostlineStatsTool();
    const r = await t.run({ action: 'bogus' }, ctx());
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/unknown action/);
  });

  it('action=health reports uptime + missing dirs gracefully', async () => {
    const tool = createPostlineStatsTool({
      processStartedAtMs: 1_000_000,
      nowMs: () => 1_000_000 + 125_000, // 2m 5s later
    });
    const r = await tool.run({ action: 'health' }, ctx());
    expect(r.content).toMatch(/uptime: 2m 5s/);
    expect(r.content).toMatch(/memory: \(not configured\)/);
    expect(r.content).toMatch(/history: in-memory/);
    expect(r.content).toMatch(/usage log: not configured/);
  });

  it('action=health reports pending count via live function', async () => {
    let count = 3;
    const tool = createPostlineStatsTool({
      processStartedAtMs: 0,
      nowMs: () => 60_000,
      pendingCountFn: () => count,
    });
    const r1 = await tool.run({ action: 'health' }, ctx());
    expect(r1.content).toMatch(/pending approvals: 3/);
    count = 0;
    const r2 = await tool.run({ action: 'health' }, ctx());
    expect(r2.content).toMatch(/pending approvals: 0/);
  });

  it('action=health reports history dir file count + bytes', async () => {
    const histDir = join(tmp, 'history');
    mkdirSync(histDir);
    writeFileSync(join(histDir, 'a.jsonl'), 'xxx');
    writeFileSync(join(histDir, 'b.jsonl'), 'yyyyy');
    writeFileSync(join(histDir, 'ignore.txt'), '0');
    const tool = createPostlineStatsTool({
      historyDir: histDir,
      processStartedAtMs: 0,
      nowMs: () => 1000,
    });
    const r = await tool.run({ action: 'health' }, ctx());
    expect(r.content).toMatch(/history:.*2 conversation\(s\)/);
  });

  it('action=usage: not-configured message when usageDir absent', async () => {
    const tool = createPostlineStatsTool({});
    const r = await tool.run({ action: 'usage' }, ctx());
    expect(r.content).toMatch(/usage tracking not configured/);
  });

  it('action=usage: missing usage.jsonl is a clean message', async () => {
    const tool = createPostlineStatsTool({ usageDir: tmp });
    const r = await tool.run({ action: 'usage' }, ctx());
    expect(r.content).toMatch(/no usage data yet/);
  });

  it('action=usage: filters entries outside the window', async () => {
    const now = Date.parse('2026-05-12T12:00:00Z');
    const recent = new Date(now - 30 * 60 * 1000).toISOString(); // 30 min ago
    const old = new Date(now - 40 * 60 * 60 * 1000).toISOString(); // 40h ago
    const entries = [
      {
        at: recent,
        turnId: 't1',
        conversationId: 'c',
        model: 'claude-opus-4-7',
        iter: 0,
        usage: { inputTokens: 100, outputTokens: 50 },
      },
      {
        at: old,
        turnId: 't2',
        conversationId: 'c',
        model: 'claude-opus-4-7',
        iter: 0,
        usage: { inputTokens: 999999, outputTokens: 999999 },
      },
    ];
    writeFileSync(
      join(tmp, 'usage.jsonl'),
      `${entries.map((e) => JSON.stringify(e)).join('\n')}\n`,
    );
    const tool = createPostlineStatsTool({
      usageDir: tmp,
      nowMs: () => now,
    });
    const r = await tool.run({ action: 'usage', hours: 24 }, ctx());
    expect(r.meta?.entries).toBe(1);
    expect(r.content).toMatch(/claude-opus-4-7/);
    expect(r.content).not.toMatch(/999999/);
  });

  it('action=usage: aggregates across models and computes USD', async () => {
    const now = Date.parse('2026-05-12T12:00:00Z');
    const at = new Date(now - 60_000).toISOString();
    const entries = [
      {
        at,
        turnId: 't1',
        conversationId: 'c',
        model: 'amazon-bedrock/us.anthropic.claude-opus-4-7',
        iter: 0,
        usage: { inputTokens: 1_000_000, outputTokens: 0 },
      },
      {
        at,
        turnId: 't2',
        conversationId: 'c',
        model: 'anthropic/claude-sonnet-4-6',
        iter: 0,
        usage: { inputTokens: 1_000_000, outputTokens: 0 },
      },
    ];
    writeFileSync(
      join(tmp, 'usage.jsonl'),
      `${entries.map((e) => JSON.stringify(e)).join('\n')}\n`,
    );
    const tool = createPostlineStatsTool({
      usageDir: tmp,
      nowMs: () => now,
    });
    const r = await tool.run({ action: 'usage' }, ctx());
    // opus 15 + sonnet 3 = 18
    expect(r.meta?.totalUsd).toBeCloseTo(18);
    expect(r.meta?.entries).toBe(2);
  });

  it('action=usage: unknown model reports usd=? and marks anyUnknown', async () => {
    const now = Date.parse('2026-05-12T12:00:00Z');
    const at = new Date(now - 60_000).toISOString();
    writeFileSync(
      join(tmp, 'usage.jsonl'),
      `${JSON.stringify({
        at,
        turnId: 't',
        conversationId: 'c',
        model: 'some-random/model-we-dont-price',
        iter: 0,
        usage: { inputTokens: 1000, outputTokens: 500 },
      })}\n`,
    );
    const tool = createPostlineStatsTool({ usageDir: tmp, nowMs: () => now });
    const r = await tool.run({ action: 'usage' }, ctx());
    expect(r.content).toMatch(/\?/);
    expect(r.meta?.anyUnknown).toBe(true);
  });

  it('action=usage: skips corrupt JSONL lines without crashing', async () => {
    const now = Date.parse('2026-05-12T12:00:00Z');
    const at = new Date(now - 60_000).toISOString();
    writeFileSync(
      join(tmp, 'usage.jsonl'),
      [
        JSON.stringify({
          at,
          turnId: 't',
          conversationId: 'c',
          model: 'claude-opus-4-7',
          iter: 0,
          usage: { inputTokens: 1000, outputTokens: 500 },
        }),
        '{not valid',
        '',
      ].join('\n'),
    );
    const tool = createPostlineStatsTool({ usageDir: tmp, nowMs: () => now });
    const r = await tool.run({ action: 'usage' }, ctx());
    expect(r.meta?.entries).toBe(1);
  });
});

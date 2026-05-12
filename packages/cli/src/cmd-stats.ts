import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { loadPostlineConfig } from '@postline/config';
import { type UsageEntry, estimateUsd, findModelPrice, formatUsd } from '@postline/core';

/**
 * `postline stats`: aggregate usage.jsonl into per-model totals for tokens
 * and estimated USD cost. Reads cfg.usage.dir; if usage is not configured,
 * prints a hint and exits 0.
 */
export async function runStats(argv: readonly string[]): Promise<void> {
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(
      [
        'Usage: postline stats [--json]',
        '',
        '  Aggregate token + cost usage from ${cfg.usage.dir}/usage.jsonl.',
        '  Group by model; show input / output / cache tokens and estimated USD.',
        '',
        '  Config: set `usage: { kind: "fs", dir: "..." }` in postline.config.ts',
        '  to start recording. Existing runs prior to that flag are not captured.',
        '',
      ].join('\n'),
    );
    return;
  }

  const json = argv.includes('--json');

  const cfg = await loadPostlineConfig();
  const u = cfg.usage;
  if (!u || u.kind !== 'fs') {
    process.stdout.write(
      `${[
        '(no usage recording configured)',
        'Enable by setting in postline.config.ts:',
        '',
        '  usage: { kind: "fs", dir: `${process.env.HOME}/.postline/usage` },',
        '',
        'Then every turn will append one entry per LLM call to <dir>/usage.jsonl.',
      ].join('\n')}\n`,
    );
    return;
  }

  const path = join(u.dir, 'usage.jsonl');
  if (!existsSync(path)) {
    process.stdout.write(`(no usage data yet at ${path})\n`);
    return;
  }

  const raw = await readFile(path, 'utf8');
  const entries: UsageEntry[] = [];
  for (const line of raw.split('\n')) {
    if (!line) continue;
    try {
      entries.push(JSON.parse(line) as UsageEntry);
    } catch {
      // skip malformed
    }
  }

  if (entries.length === 0) {
    process.stdout.write('(0 usage entries)\n');
    return;
  }

  // Aggregate per model
  const agg = new Map<
    string,
    {
      model: string;
      calls: number;
      input: number;
      output: number;
      cacheRead: number;
      cacheCreation: number;
      usd: number;
      usdKnown: boolean;
    }
  >();
  for (const e of entries) {
    const a = agg.get(e.model) ?? {
      model: e.model,
      calls: 0,
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheCreation: 0,
      usd: 0,
      usdKnown: findModelPrice(e.model) !== undefined,
    };
    a.calls += 1;
    a.input += e.usage.inputTokens;
    a.output += e.usage.outputTokens;
    a.cacheRead += e.usage.cacheReadTokens ?? 0;
    a.cacheCreation += e.usage.cacheCreationTokens ?? 0;
    const usd = estimateUsd(e.usage, e.model);
    if (usd !== undefined) a.usd += usd;
    agg.set(e.model, a);
  }
  const rows = [...agg.values()].sort((x, y) => y.usd - x.usd || y.input - x.input);

  if (json) {
    for (const r of rows) process.stdout.write(`${JSON.stringify(r)}\n`);
    return;
  }

  // Pretty table.
  const header = {
    model: 'MODEL',
    calls: 'CALLS',
    input: 'INPUT',
    output: 'OUTPUT',
    cache: 'CACHE R/W',
    usd: 'USD',
  };
  const fmt = (n: number): string =>
    n >= 1_000_000
      ? `${(n / 1_000_000).toFixed(2)}M`
      : n >= 1000
        ? `${(n / 1000).toFixed(1)}k`
        : String(n);
  const rowStrings = rows.map((r) => ({
    model: r.model.length > 50 ? `…${r.model.slice(-49)}` : r.model,
    calls: String(r.calls),
    input: fmt(r.input),
    output: fmt(r.output),
    cache: `${fmt(r.cacheRead)} / ${fmt(r.cacheCreation)}`,
    usd: r.usdKnown ? formatUsd(r.usd) : '?',
  }));
  const widths = {
    model: Math.max(header.model.length, ...rowStrings.map((r) => r.model.length)),
    calls: Math.max(header.calls.length, ...rowStrings.map((r) => r.calls.length)),
    input: Math.max(header.input.length, ...rowStrings.map((r) => r.input.length)),
    output: Math.max(header.output.length, ...rowStrings.map((r) => r.output.length)),
    cache: Math.max(header.cache.length, ...rowStrings.map((r) => r.cache.length)),
    usd: Math.max(header.usd.length, ...rowStrings.map((r) => r.usd.length)),
  };
  const pad = (s: string, n: number): string => s + ' '.repeat(Math.max(0, n - s.length));
  const line = (r: typeof header): string =>
    [
      pad(r.model, widths.model),
      pad(r.calls, widths.calls),
      pad(r.input, widths.input),
      pad(r.output, widths.output),
      pad(r.cache, widths.cache),
      pad(r.usd, widths.usd),
    ].join('  ');

  process.stdout.write(`${line(header)}\n`);
  process.stdout.write(
    `${[
      '-'.repeat(widths.model),
      '-'.repeat(widths.calls),
      '-'.repeat(widths.input),
      '-'.repeat(widths.output),
      '-'.repeat(widths.cache),
      '-'.repeat(widths.usd),
    ].join('  ')}\n`,
  );
  for (const r of rowStrings) process.stdout.write(`${line(r)}\n`);

  const totalCalls = rows.reduce((s, r) => s + r.calls, 0);
  const totalUsd = rows.reduce((s, r) => s + (r.usdKnown ? r.usd : 0), 0);
  const totalInput = rows.reduce((s, r) => s + r.input, 0);
  const totalOutput = rows.reduce((s, r) => s + r.output, 0);
  const hasUnknown = rows.some((r) => !r.usdKnown);
  process.stdout.write(
    `\n${entries.length} entries across ${totalCalls} calls — ${fmt(totalInput)} input, ${fmt(totalOutput)} output, ${formatUsd(totalUsd)} est.${hasUnknown ? ' (some unpriced)' : ''}\n`,
  );
}

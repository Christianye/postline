import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { type Tool, type UsageEntry, estimateUsd, findModelPrice, formatUsd } from '@postline/core';

export interface PostlineStatsOptions {
  /** Absolute path to the memory dir. Used for the `health` action. */
  memoryDir?: string;
  /** Absolute path to the history dir (same as cfg.history.dir). Used for `health`. */
  historyDir?: string;
  /** Absolute path to the usage dir (cfg.usage.dir). Required for `action: 'usage'`. */
  usageDir?: string;
  /**
   * Count of pending dangerous-tool approvals. The tool-assembly layer injects
   * a live getter so the count is current at tool-call time, not tool-build
   * time.
   */
  pendingCountFn?: () => number;
  /** Epoch ms when the process started. Defaults to `Date.now()` at build. */
  processStartedAtMs?: number;
  /** Test-only clock injection. Defaults to `() => Date.now()`. */
  nowMs?: () => number;
}

/**
 * One tool with two actions for bot self-reflection:
 *
 *   action: 'usage'  — aggregate token + $ usage from usage.jsonl (last N hours)
 *   action: 'health' — local process state: uptime, memory/history/pending
 *
 * Risk is `read`. No network, no subprocess spawn except a single `git status`
 * probe on the memory dir. Scales to the sizes a single-operator deployment
 * produces (tens of thousands of usage lines, a few hundred history files).
 */
export function createPostlineStatsTool(opts: PostlineStatsOptions = {}): Tool {
  const nowMs = opts.nowMs ?? (() => Date.now());
  const processStartedAtMs = opts.processStartedAtMs ?? nowMs();

  return {
    name: 'postline_stats',
    description:
      "Report postline bot self-state. action='usage' aggregates token + USD usage from the usage log over the last `hours` (default 24). action='health' reports process uptime, memory/history dir status, and pending-approval count. Risk: read.",
    risk: 'read',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['usage', 'health'] },
        hours: {
          type: 'number',
          description: 'usage window in hours. default 24. ignored for action=health.',
        },
      },
      required: ['action'],
      additionalProperties: false,
    },
    async run(args) {
      const action = typeof args.action === 'string' ? args.action : '';
      if (action === 'usage') return runUsage(args, opts, nowMs);
      if (action === 'health') return runHealth(opts, processStartedAtMs, nowMs);
      return {
        content: `ERROR: unknown action '${action}' (expected usage | health)`,
        isError: true,
      };
    },
  };
}

async function runUsage(
  args: Record<string, unknown>,
  opts: PostlineStatsOptions,
  nowMs: () => number,
): Promise<ReturnType<Tool['run']> extends Promise<infer R> ? R : never> {
  const hours = typeof args.hours === 'number' && args.hours > 0 ? args.hours : 24;
  const cutoff = nowMs() - hours * 60 * 60 * 1000;

  if (!opts.usageDir) {
    return {
      content:
        '(usage tracking not configured — set cfg.usage = { kind: "fs", dir: "..." } in postline.config.ts)',
    };
  }
  const path = join(opts.usageDir, 'usage.jsonl');
  if (!existsSync(path)) {
    return { content: `(no usage data yet at ${path})` };
  }

  const raw = await readFile(path, 'utf8');
  const entries: UsageEntry[] = [];
  for (const line of raw.split('\n')) {
    if (!line) continue;
    try {
      const e = JSON.parse(line) as UsageEntry;
      if (new Date(e.at).getTime() >= cutoff) entries.push(e);
    } catch {
      /* skip corrupt */
    }
  }

  if (entries.length === 0) {
    return {
      content: `(no usage entries in the last ${hours} hour(s))`,
      meta: { hours, entries: 0 },
    };
  }

  const agg = new Map<
    string,
    {
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

  const lines: string[] = [
    `Last ${hours}h — ${entries.length} call(s) across ${agg.size} model(s):`,
  ];
  let totalUsd = 0;
  let anyUnknown = false;
  for (const [model, a] of agg) {
    if (a.usdKnown) totalUsd += a.usd;
    else anyUnknown = true;
    lines.push(
      `  ${model}: ${a.calls} call(s), ${fmtTokens(a.input)} in, ${fmtTokens(a.output)} out, cache ${fmtTokens(a.cacheRead)}R/${fmtTokens(a.cacheCreation)}W → ${a.usdKnown ? formatUsd(a.usd) : '?'}`,
    );
  }
  lines.push(`Total: ${formatUsd(totalUsd)}${anyUnknown ? ' (some models unpriced)' : ''}`);

  return {
    content: lines.join('\n'),
    meta: { hours, entries: entries.length, totalUsd, anyUnknown },
  };
}

async function runHealth(
  opts: PostlineStatsOptions,
  processStartedAtMs: number,
  nowMs: () => number,
): Promise<ReturnType<Tool['run']> extends Promise<infer R> ? R : never> {
  const uptimeMs = nowMs() - processStartedAtMs;
  const out: string[] = [];
  out.push(`uptime: ${fmtDuration(uptimeMs)}`);

  // Node info, cheap.
  out.push(`node: ${process.version}`);

  // Memory dir
  if (opts.memoryDir) {
    if (existsSync(opts.memoryDir)) {
      const gitInfo = probeGit(opts.memoryDir);
      out.push(`memory: ${opts.memoryDir} (${gitInfo})`);
    } else {
      out.push(`memory: ${opts.memoryDir} — MISSING`);
    }
  } else {
    out.push('memory: (not configured)');
  }

  // History dir: files + approx total size
  if (opts.historyDir) {
    const info = await probeHistory(opts.historyDir);
    out.push(`history: ${opts.historyDir} (${info})`);
  } else {
    out.push('history: in-memory (not persisted)');
  }

  // Usage dir
  if (opts.usageDir) {
    const p = join(opts.usageDir, 'usage.jsonl');
    if (existsSync(p)) {
      try {
        const s = await stat(p);
        out.push(`usage log: ${p} (${fmtBytes(s.size)})`);
      } catch (e) {
        out.push(`usage log: ${p} — stat failed: ${(e as Error).message}`);
      }
    } else {
      out.push(`usage log: ${p} — not yet written`);
    }
  } else {
    out.push('usage log: not configured');
  }

  // Pending approvals
  if (opts.pendingCountFn) {
    const n = opts.pendingCountFn();
    out.push(`pending approvals: ${n}`);
  }

  return { content: out.join('\n') };
}

function probeGit(dir: string): string {
  try {
    const r = spawnSync('git', ['-C', dir, 'status', '--porcelain'], {
      encoding: 'utf8',
      timeout: 2000,
    });
    if (r.status === 0) {
      const dirty = (r.stdout ?? '').trim().length > 0;
      return dirty ? 'git-backed, dirty' : 'git-backed, clean';
    }
    return 'not a git repo';
  } catch {
    return 'git probe failed';
  }
}

async function probeHistory(dir: string): Promise<string> {
  if (!existsSync(dir)) return 'does not exist';
  try {
    const files = (await readdir(dir)).filter((f) => f.endsWith('.jsonl'));
    let totalSize = 0;
    for (const f of files) {
      try {
        const s = await stat(join(dir, f));
        totalSize += s.size;
      } catch {
        /* skip */
      }
    }
    return `${files.length} conversation(s), ${fmtBytes(totalSize)}`;
  } catch (e) {
    return `read failed: ${(e as Error).message}`;
  }
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

function fmtBytes(n: number): string {
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)}MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${n}B`;
}

function fmtDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  const d = Math.floor(h / 24);
  return `${d}d ${h % 24}h`;
}

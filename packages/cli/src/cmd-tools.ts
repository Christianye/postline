import { loadPostlineConfig, validateConfig } from '@postline/config';
import { type Tool, createLogger } from '@postline/core';
import { assembleTools } from './tool-assembly.js';

/**
 * `postline tools`: enumerate every tool the turn runner would receive given
 * the current config. Useful for sanity checks, screenshots, and
 * "what does the model actually see?" debugging.
 *
 * Does NOT call any LLM. Does spawn MCP subprocesses (required to list their
 * tools), then shuts them down before exit.
 */
export async function runTools(argv: readonly string[]): Promise<void> {
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(
      [
        'Usage: postline tools [--json]',
        '',
        '  List every tool the turn runner would receive given the current',
        '  postline.config.ts: builtin tools + MCP-sourced tools + Claude Code',
        '  skills. Output columns: name, risk, source.',
        '',
        '  --json   emit one object per line (jq-friendly) instead of a table',
        '',
        '  Does not call any LLM. Does spawn MCP subprocesses to list their',
        '  tools — they are shut down before exit.',
        '',
      ].join('\n'),
    );
    return;
  }

  const json = argv.includes('--json');

  const cfg = await loadPostlineConfig();
  const errors = validateConfig(cfg);
  if (errors.length > 0) {
    process.stderr.write(`invalid config:\n${errors.map((e) => `  - ${e}`).join('\n')}\n`);
    process.exit(2);
  }

  // Silence the log during listing — we want stdout clean for scripting.
  const log = createLogger({ level: 'silent' });

  const { tools, mcp } = await assembleTools(
    cfg,
    {
      memoryDir: cfg.memory.dir,
      ...(cfg.feishu
        ? { feishu: { appId: cfg.feishu.appId, appSecret: cfg.feishu.appSecret } }
        : {}),
    },
    log,
  );

  try {
    const rows = [...tools.values()].map((t) => ({
      name: t.name,
      risk: t.risk,
      source: classifySource(t),
    }));
    rows.sort(
      (a, b) => sourceOrder(a.source) - sourceOrder(b.source) || a.name.localeCompare(b.name),
    );

    if (json) {
      for (const r of rows) process.stdout.write(`${JSON.stringify(r)}\n`);
    } else {
      const header = { name: 'NAME', risk: 'RISK', source: 'SOURCE' };
      const widths = {
        name: Math.max(header.name.length, ...rows.map((r) => r.name.length)),
        risk: Math.max(header.risk.length, ...rows.map((r) => r.risk.length)),
        source: Math.max(header.source.length, ...rows.map((r) => r.source.length)),
      };
      const pad = (s: string, n: number): string => s + ' '.repeat(Math.max(0, n - s.length));
      const line = (r: typeof header): string =>
        `${pad(r.name, widths.name)}  ${pad(r.risk, widths.risk)}  ${pad(r.source, widths.source)}`;
      process.stdout.write(`${line(header)}\n`);
      process.stdout.write(
        `${'-'.repeat(widths.name)}  ${'-'.repeat(widths.risk)}  ${'-'.repeat(widths.source)}\n`,
      );
      for (const r of rows) process.stdout.write(`${line(r)}\n`);
      process.stdout.write(`\n${rows.length} tool(s) loaded\n`);
    }
  } finally {
    if (mcp) await mcp.shutdown();
  }
}

/** Rough classifier. MCP and skill tools have a prefix; rest are builtin. */
function classifySource(t: Tool): string {
  if (t.name.startsWith('mcp_')) {
    // mcp_<server>_<toolName> — extract server name
    const rest = t.name.slice('mcp_'.length);
    const underscore = rest.indexOf('_');
    return underscore > 0 ? `mcp:${rest.slice(0, underscore)}` : 'mcp:?';
  }
  if (t.name.startsWith('skill_')) return 'skill';
  return 'builtin';
}

function sourceOrder(source: string): number {
  if (source === 'builtin') return 0;
  if (source.startsWith('mcp:')) return 1;
  if (source === 'skill') return 2;
  return 9;
}

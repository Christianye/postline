import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { loadPostlineConfig } from '@postline/config';
import { type UsageEntry, estimateUsd, findModelPrice, formatUsd } from '@postline/core';
import { auditHistoryDir } from './history-fs.js';

/**
 * `postline daily-report`: assemble a markdown digest of yesterday's
 * postline activity and either print it (default) or send it via the
 * feishu_send API to the configured target chat. Designed for cron/timer
 * invocation; standalone process, does not touch the running cc.service.
 *
 * Sections:
 *   - Usage: tokens + USD per model (last 24h or --hours), cache split
 *   - Health: systemctl-derived uptime / PID / NRestarts; memory dir status
 *   - History: orphan audit summary
 *   - Errors: grep recent journalctl for retry/fallback/error counts
 */
export async function runDailyReport(argv: readonly string[]): Promise<void> {
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(
      [
        'Usage: postline daily-report [--hours N] [--send] [--target <open_id|chat_id>]',
        '',
        '  --hours N    aggregation window in hours. Default 24.',
        '  --send       send the digest via feishu im.v1.message.create instead of just printing.',
        '  --target X   override the configured ops target. Default: first allowlist open_id.',
        '',
      ].join('\n'),
    );
    return;
  }

  const cfg = await loadPostlineConfig();
  const hours = parseNumberArg(argv, '--hours') ?? 24;
  const shouldSend = argv.includes('--send');
  const target = parseStringArg(argv, '--target') ?? cfg.allowlist.openIds[0];

  const sections: string[] = [];
  const headerDate = new Date().toISOString().split('T')[0];
  sections.push(`🦞 postline daily — ${headerDate}`, '');

  sections.push(...(await usageSection(cfg, hours)));
  sections.push('', ...(await healthSection(cfg)));
  sections.push('', ...(await historySection(cfg)));
  sections.push('', ...errorsSection(hours));

  const digest = sections.join('\n');

  if (!shouldSend) {
    process.stdout.write(`${digest}\n`);
    return;
  }

  if (!target) {
    process.stderr.write(
      'daily-report --send requires a target; pass --target <open_id> or set allowlist.openIds[0].\n',
    );
    process.exit(2);
  }
  if (!cfg.feishu) {
    process.stderr.write('daily-report --send requires cfg.feishu (appId + appSecret).\n');
    process.exit(2);
  }
  await sendViaFeishu(cfg.feishu, target, digest);
  process.stdout.write(`sent to ${target} (${digest.length} chars)\n`);
}

function parseStringArg(argv: readonly string[], flag: string): string | undefined {
  const i = argv.indexOf(flag);
  if (i < 0 || i + 1 >= argv.length) return undefined;
  return argv[i + 1];
}

function parseNumberArg(argv: readonly string[], flag: string): number | undefined {
  const v = parseStringArg(argv, flag);
  if (v === undefined) return undefined;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

async function usageSection(
  cfg: Awaited<ReturnType<typeof loadPostlineConfig>>,
  hours: number,
): Promise<string[]> {
  const out: string[] = [`## Usage (last ${hours}h)`];
  const usageDir = cfg.usage && cfg.usage.kind === 'fs' ? cfg.usage.dir : undefined;
  if (!usageDir) {
    out.push('(usage tracking not configured)');
    return out;
  }
  const path = join(usageDir, 'usage.jsonl');
  if (!existsSync(path)) {
    out.push(`(no usage data yet at ${path})`);
    return out;
  }
  const cutoff = Date.now() - hours * 60 * 60 * 1000;
  const raw = await readFile(path, 'utf8');
  const entries: UsageEntry[] = [];
  for (const line of raw.split('\n')) {
    if (!line) continue;
    try {
      const e = JSON.parse(line) as UsageEntry;
      if (new Date(e.at).getTime() >= cutoff) entries.push(e);
    } catch {
      // skip corrupt
    }
  }
  if (entries.length === 0) {
    out.push(`(no usage entries in the last ${hours}h)`);
    return out;
  }
  type Agg = {
    calls: number;
    input: number;
    output: number;
    cacheRead: number;
    cacheCreation: number;
    usd: number;
    usdKnown: boolean;
  };
  const byModel = new Map<string, Agg>();
  for (const e of entries) {
    const a = byModel.get(e.model) ?? {
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
    byModel.set(e.model, a);
  }
  let totalUsd = 0;
  let cacheReadTotal = 0;
  let cacheCreationTotal = 0;
  let anyUnknown = false;
  out.push(`- ${entries.length} call(s) across ${byModel.size} model(s)`);
  for (const [model, a] of byModel) {
    if (a.usdKnown) totalUsd += a.usd;
    else anyUnknown = true;
    cacheReadTotal += a.cacheRead;
    cacheCreationTotal += a.cacheCreation;
    out.push(
      `  - ${model}: ${a.calls} calls, ${fmtTokens(a.input)} in, ${fmtTokens(a.output)} out → ${a.usdKnown ? formatUsd(a.usd) : '?'}`,
    );
  }
  out.push(`- Cache: ${fmtTokens(cacheReadTotal)} read / ${fmtTokens(cacheCreationTotal)} write`);
  out.push(`- Total: ${formatUsd(totalUsd)}${anyUnknown ? ' (some models unpriced)' : ''}`);
  return out;
}

async function healthSection(
  cfg: Awaited<ReturnType<typeof loadPostlineConfig>>,
): Promise<string[]> {
  const out: string[] = ['## Health'];
  // Service state via systemctl. Fail soft if not on a systemd host.
  const r = spawnSync(
    'systemctl',
    ['show', 'cc.service', '--property=MainPID,ActiveState,NRestarts,ActiveEnterTimestamp'],
    { encoding: 'utf8', timeout: 2000 },
  );
  if (r.status === 0) {
    const fields = parseSystemctlShow(r.stdout ?? '');
    out.push(`- service: ${fields.ActiveState ?? 'unknown'} (pid ${fields.MainPID ?? '?'})`);
    if (fields.ActiveEnterTimestamp) {
      out.push(`- started: ${fields.ActiveEnterTimestamp}`);
    }
    if (fields.NRestarts !== undefined) {
      out.push(`- restarts since boot: ${fields.NRestarts}`);
    }
  } else {
    out.push('- service: systemctl unavailable');
  }
  // Memory dir
  if (cfg.memory?.dir && existsSync(cfg.memory.dir)) {
    const dirty = probeGitDirty(cfg.memory.dir);
    out.push(`- memory: ${cfg.memory.dir} (${dirty})`);
  }
  return out;
}

function probeGitDirty(dir: string): string {
  try {
    const r = spawnSync('git', ['-C', dir, 'status', '--porcelain'], {
      encoding: 'utf8',
      timeout: 2000,
    });
    if (r.status !== 0) return 'not a git repo';
    return (r.stdout ?? '').trim().length > 0 ? 'git-backed, dirty' : 'git-backed, clean';
  } catch {
    return 'git probe failed';
  }
}

function parseSystemctlShow(text: string): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const line of text.split('\n')) {
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    out[line.slice(0, eq)] = line.slice(eq + 1).trim();
  }
  return out;
}

async function historySection(
  cfg: Awaited<ReturnType<typeof loadPostlineConfig>>,
): Promise<string[]> {
  const out: string[] = ['## History'];
  if (!cfg.history || cfg.history.kind !== 'fs') {
    out.push('- history not on disk');
    return out;
  }
  const audit = await auditHistoryDir(cfg.history.dir);
  out.push(
    `- ${audit.total.files} conversation(s), ${audit.total.rows} row(s), ${audit.total.orphans} orphan(s), ${audit.total.corruptLines} corrupt line(s)`,
  );
  if (audit.total.orphans > 0) {
    const ranked = [...audit.files]
      .filter((f) => f.totalOrphans > 0)
      .sort((a, b) => b.totalOrphans - a.totalOrphans)
      .slice(0, 3);
    for (const f of ranked) {
      out.push(`  - ${f.file}: ${f.totalOrphans} orphan(s) in ${f.rows} row(s)`);
    }
  }
  return out;
}

function errorsSection(hours: number): string[] {
  const out: string[] = ['## Signals (journalctl)'];
  const since = `${hours} hours ago`;
  const r = spawnSync(
    'sudo',
    ['-n', 'journalctl', '-u', 'cc.service', '--since', since, '--no-pager', '-o', 'cat'],
    { encoding: 'utf8', timeout: 5000 },
  );
  if (r.status !== 0) {
    out.push(`- journalctl unavailable (status ${r.status})`);
    return out;
  }
  const text = r.stdout ?? '';
  const counts = {
    retry: countMatches(text, /"msg":"provider_retry"/g),
    attemptFailed: countMatches(
      text,
      /"msg":"bedrock_attempt_failed|"msg":"anthropic_attempt_failed/g,
    ),
    streamError: countMatches(text, /"msg":"stream_error"/g),
    orphanDropped: countMatches(text, /"msg":"history_orphan_/g),
    routingSmall: countMatches(text, /"msg":"feishu_routing_small_model"/g),
    routingTotal: countMatches(text, /"msg":"feishu_inbound"/g),
  };
  out.push(`- provider retries: ${counts.retry}`);
  out.push(`- attempt failures (any provider): ${counts.attemptFailed}`);
  out.push(`- stream errors: ${counts.streamError}`);
  out.push(`- history orphan rows dropped: ${counts.orphanDropped}`);
  if (counts.routingTotal > 0) {
    const pct =
      counts.routingTotal > 0 ? Math.round((counts.routingSmall / counts.routingTotal) * 100) : 0;
    out.push(
      `- routing: ${counts.routingSmall}/${counts.routingTotal} turn(s) routed to small model (${pct}%)`,
    );
  }
  return out;
}

function countMatches(s: string, re: RegExp): number {
  return (s.match(re) ?? []).length;
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

async function sendViaFeishu(
  feishu: { appId: string; appSecret: string },
  receiveId: string,
  text: string,
): Promise<void> {
  // Match feishu_send tool's wire shape (im.v1.message.create) but use
  // direct fetch + tenant_access_token to avoid pulling in @larksuiteoapi
  // here.
  const tokenResp = await fetch(
    'https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ app_id: feishu.appId, app_secret: feishu.appSecret }),
    },
  );
  const tokenJson = (await tokenResp.json()) as {
    tenant_access_token?: string;
    code?: number;
    msg?: string;
  };
  if (!tokenJson.tenant_access_token) {
    throw new Error(`feishu auth failed: code=${tokenJson.code} msg=${tokenJson.msg}`);
  }
  const isOpenId = receiveId.startsWith('ou_');
  const isChatId = receiveId.startsWith('oc_');
  if (!isOpenId && !isChatId) {
    throw new Error(`target ${receiveId} is neither open_id (ou_) nor chat_id (oc_)`);
  }
  const receiveType = isOpenId ? 'open_id' : 'chat_id';
  const sendResp = await fetch(
    `https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=${receiveType}`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${tokenJson.tenant_access_token}`,
      },
      body: JSON.stringify({
        receive_id: receiveId,
        msg_type: 'text',
        content: JSON.stringify({ text }),
      }),
    },
  );
  const sendJson = (await sendResp.json()) as { code?: number; msg?: string };
  if (sendJson.code !== 0) {
    throw new Error(`feishu send failed: code=${sendJson.code} msg=${sendJson.msg}`);
  }
}

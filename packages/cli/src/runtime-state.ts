import { spawnSync } from 'node:child_process';
import type { PostlineConfig } from '@postline/config';

/**
 * Build a static runtime-state fragment to prepend to the model's system
 * prompt. Captures the bot's PID, process start time, git HEAD, and key
 * runtime feature flags so the model can answer questions like "have you
 * restarted recently?" or "are you running with thinking enabled?" without
 * having to guess from conversation context.
 *
 * Computed once at process startup. The string is stable for the lifetime
 * of the process, which keeps the Anthropic prompt cache stable — if we
 * inlined a live uptime counter the cache would miss on every turn.
 *
 * The model can derive uptime by subtracting `started_at` from "current
 * time" (Anthropic injects current time in the system header).
 */
export function buildRuntimeStateSuffix(cfg: PostlineConfig): string {
  const startedAtIso = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  const gitHead = readGitHead() ?? 'unknown';
  const node = process.version;
  const thinking = cfg.inference?.thinking?.enabled ? 'on' : 'off';
  const thinkingEffort = cfg.inference?.thinking?.effort ?? '-';
  const streaming = cfg.feishu?.streaming ? 'on' : 'off';
  const requesterOnly = cfg.feishu?.approval?.requesterOnly !== false ? 'on' : 'off';

  return [
    '',
    '## Runtime state (this process)',
    '',
    'You are a long-lived process. The state below is captured at startup',
    'and is stable for this process lifetime; if user asks about uptime,',
    'subtract `started_at` from the current time. If you got restarted,',
    'pid / started_at / git change.',
    '',
    `- pid: ${process.pid}`,
    `- started_at: ${startedAtIso}`,
    `- node: ${node}`,
    `- git: ${gitHead}`,
    `- model: ${cfg.model}`,
    `- thinking: ${thinking}${thinking === 'on' ? ` (effort=${thinkingEffort})` : ''}`,
    `- streaming: ${streaming}`,
    `- requesterOnly: ${requesterOnly}`,
  ].join('\n');
}

function readGitHead(): string | undefined {
  try {
    const r = spawnSync('git', ['rev-parse', '--short=12', 'HEAD'], {
      encoding: 'utf8',
      timeout: 2000,
    });
    if (r.status !== 0) return undefined;
    const out = (r.stdout ?? '').trim();
    return out.length > 0 ? out : undefined;
  } catch {
    return undefined;
  }
}

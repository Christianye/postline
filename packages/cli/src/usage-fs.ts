import { appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { Logger, UsageEntry, UsageRecorder } from '@postline/core';

/**
 * JSONL-backed usage recorder. One line per (turn × iteration) carrying the
 * token counts and model id the provider reported. Consumed by
 * `postline stats`.
 *
 * Path: `${dir}/usage.jsonl`
 */
export function createFsUsageRecorder(opts: { dir: string; log?: Logger }): UsageRecorder {
  const { dir, log } = opts;
  const file = join(dir, 'usage.jsonl');
  let inited = false;

  async function ensureDir(): Promise<void> {
    if (inited) return;
    await mkdir(dir, { recursive: true });
    inited = true;
  }

  return {
    async record(entry: UsageEntry) {
      try {
        await ensureDir();
        await appendFile(file, `${JSON.stringify(entry)}\n`, 'utf8');
      } catch (e) {
        log?.warn({ err: (e as Error).message }, 'usage_fs_append_failed');
      }
    },
  };
}

import type { PostlineConfig } from '@postline/config';
import type { Logger, UsageRecorder } from '@postline/core';
import { createFsUsageRecorder } from './usage-fs.js';

/**
 * Resolve the optional UsageRecorder per `cfg.usage`. When nothing is
 * configured, return undefined so runTurn skips the recorder call entirely.
 */
export function createUsageRecorder(cfg: PostlineConfig, log: Logger): UsageRecorder | undefined {
  const u = cfg.usage;
  if (u && u.kind === 'fs') {
    log.info({ dir: u.dir }, 'usage_recorder_fs');
    return createFsUsageRecorder({ dir: u.dir, log });
  }
  return undefined;
}

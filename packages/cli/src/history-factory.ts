import type { PostlineConfig } from '@postline/config';
import type { HistoryStore, Logger, MetricsRegistry } from '@postline/core';
import { createFsHistory } from './history-fs.js';
import { createMemoryHistory } from './history-memory.js';

/**
 * Resolve the HistoryStore implementation per `cfg.history`. Default
 * behaviour (no config) is in-memory to match 0.1.x behaviour; opt into
 * filesystem persistence with `history: { kind: 'fs', dir: '...' }`.
 */
export function createHistory(
  cfg: PostlineConfig,
  log: Logger,
  metrics?: MetricsRegistry,
): HistoryStore {
  const h = cfg.history;
  if (h && h.kind === 'fs') {
    log.info({ dir: h.dir }, 'history_store_fs');
    return createFsHistory({ dir: h.dir, log, ...(metrics ? { metrics } : {}) });
  }
  return createMemoryHistory();
}

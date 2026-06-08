import { existsSync, readFileSync } from 'node:fs';
import chokidar, { type FSWatcher } from 'chokidar';
import type { Logger } from '../types.js';
import { parseRoutingMarkdown } from './parser.js';
import type { RoutingConfig } from './types.js';

/**
 * Live RoutingConfig — owns parsing + chokidar reload, exposes a
 * pointer-swap snapshot the matcher can read without locks.
 *
 * Atomic swap (per design D09):
 * - parse the file off-watch
 * - validate
 * - swap `current` to the new config
 * - in-flight callers using the old snapshot continue to see the old
 *   config until they re-read; the matcher captures `snapshot()` at
 *   request entry, so a reload mid-request never serves a half-loaded
 *   config.
 *
 * Failure handling: malformed file logs a warning and keeps the prior
 * snapshot. The optional `onParseFailure` hook lets the cli surface a
 * Feishu DM to the operator so a routing edit that broke the file
 * doesn't go unnoticed.
 */

export interface RoutingLoaderOptions {
  /** Absolute path to routing.md. Doesn't have to exist on first load. */
  path: string;
  log: Logger;
  /**
   * Debounce reload events to avoid double-firing on common editor
   * save patterns (write+rename, vim swap files, etc). Default 300ms.
   */
  reloadDebounceMs?: number;
  /**
   * Hook fired when a reload's parse fails — the loader keeps the prior
   * snapshot, but the operator should know.
   */
  onParseFailure?: (err: { path: string; message: string }) => void;
}

export interface RoutingLoaderHandle {
  /** Read the current config snapshot. */
  snapshot(): RoutingConfig;
  /** Stop the watcher. Idempotent. */
  close(): Promise<void>;
}

/** Empty config: no matching tokens, nothing routes anywhere. */
export function emptyRoutingConfig(): RoutingConfig {
  return {
    workerAliases: new Map(),
    projects: [],
    dispatchToMacTokens: [],
    ec2SelfSolveTokens: [],
    ec2DirectAnswerTokens: [],
    destructiveVerbs: [],
  };
}

/**
 * Build a loader. Synchronously reads the file once if it exists; then
 * starts a chokidar watcher that re-parses on change.
 */
export function startRoutingLoader(opts: RoutingLoaderOptions): RoutingLoaderHandle {
  const log = opts.log.child({ component: 'routing_loader', path: opts.path });
  let current: RoutingConfig = readOrEmpty(opts.path, log);
  const debounceMs = opts.reloadDebounceMs ?? 300;
  let debounceTimer: NodeJS.Timeout | null = null;

  const reload = (): void => {
    try {
      if (!existsSync(opts.path)) {
        log.warn({}, 'routing_md_missing_on_reload');
        return;
      }
      const body = readFileSync(opts.path, 'utf8');
      const next = parseRoutingMarkdown(body);
      // Atomic swap: assign the pointer last, after parse succeeded.
      current = next;
      log.info(
        {
          projects: next.projects.length,
          dispatchTokens: next.dispatchToMacTokens.length,
          aliases: next.workerAliases.size,
        },
        'routing_md_reloaded',
      );
    } catch (err) {
      const message = (err as Error).message;
      log.warn({ message }, 'routing_md_parse_failed');
      try {
        opts.onParseFailure?.({ path: opts.path, message });
      } catch (cbErr) {
        log.warn({ cbErr: (cbErr as Error).message }, 'routing_md_parse_hook_error');
      }
    }
  };

  const watcher: FSWatcher = chokidar.watch(opts.path, {
    persistent: true,
    ignoreInitial: true,
  });
  const onChange = (): void => {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(reload, debounceMs);
    if (typeof debounceTimer.unref === 'function') debounceTimer.unref();
  };
  watcher.on('add', onChange);
  watcher.on('change', onChange);
  watcher.on('unlink', () => {
    log.warn({}, 'routing_md_unlinked');
  });
  watcher.on('error', (err) => {
    log.warn({ err: (err as Error).message }, 'routing_md_watcher_error');
  });

  log.info({ debounceMs }, 'routing_loader_started');

  return {
    snapshot: () => current,
    close: async () => {
      if (debounceTimer) {
        clearTimeout(debounceTimer);
        debounceTimer = null;
      }
      await watcher.close();
      log.info({}, 'routing_loader_stopped');
    },
  };
}

function readOrEmpty(path: string, log: Logger): RoutingConfig {
  try {
    if (!existsSync(path)) {
      log.info({}, 'routing_md_absent_using_empty');
      return emptyRoutingConfig();
    }
    const body = readFileSync(path, 'utf8');
    return parseRoutingMarkdown(body);
  } catch (err) {
    log.warn({ err: (err as Error).message }, 'routing_md_initial_load_failed');
    return emptyRoutingConfig();
  }
}

import { spawnSync } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { hostname } from 'node:os';
import { resolve, sep } from 'node:path';

/**
 * cwd canonicalisation per design §4.4.
 *
 *   1. `git rev-parse --show-toplevel` if inside a git tree; else `process.cwd()`
 *   2. fs.realpathSync to resolve symlinks
 *   3. POSIX-normalise separators (Windows path → forward slashes)
 *   4. Preserve case as-is (macOS APFS is case-insensitive but the audit
 *      log keeps what the worker actually reported)
 *
 * Pure: no global state; takes the directory under inspection as input.
 * Designed so unit tests can drop into a tmpdir without touching real
 * git state.
 */

export interface CanonicalizeOptions {
  /** Directory the user thinks they're in. Default `process.cwd()`. */
  cwd?: string;
  /**
   * For tests: override the git toplevel rather than calling `git`.
   * Returns the path to use as toplevel, or `null` to fall back to the
   * provided cwd (= no git).
   */
  gitToplevelOverride?: (dir: string) => string | null;
  /**
   * For tests: override realpath. Defaults to fs.realpathSync.
   */
  realpath?: (p: string) => string;
}

export function canonicalizeCwd(opts: CanonicalizeOptions = {}): string {
  const start = opts.cwd ?? process.cwd();
  const toplevel = (opts.gitToplevelOverride ?? defaultGitToplevel)(start);
  const base = toplevel ?? start;
  const realpath = opts.realpath ?? realpathSync;
  let resolved: string;
  try {
    resolved = realpath(base);
  } catch {
    // Path doesn't exist or no permission — fall back to the absolute
    // form of `base` so a worker running pre-clone (rare) still gets
    // a stable identifier.
    resolved = resolve(base);
  }
  return posixNormalise(resolved);
}

function defaultGitToplevel(dir: string): string | null {
  if (!existsSync(dir)) return null;
  try {
    const r = spawnSync('git', ['-C', dir, 'rev-parse', '--show-toplevel'], {
      encoding: 'utf8',
      timeout: 2000,
    });
    if (r.status !== 0) return null;
    const out = (r.stdout ?? '').trim();
    return out.length > 0 ? out : null;
  } catch {
    return null;
  }
}

function posixNormalise(p: string): string {
  // Convert backslash separators to forward slashes (no-op on POSIX).
  if (sep === '/') return p;
  return p.split(sep).join('/');
}

/** Stable host identifier per design §4.4 + RF3 (any host, mac/ec2/...). */
export function reportingHostname(): string {
  // os.hostname() is enough; we don't need to canonicalise since the
  // string is only used for audit logging + worker_aliases lookups.
  return hostname();
}

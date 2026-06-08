import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

/**
 * Per-(host, cwd) cc-worker pid file. Used by `cc-worker status` to
 * report whether a worker is currently running for the given workspace,
 * and by `cc-worker stop` to look up what to kill.
 *
 * Path: `~/.postline/state/cc-worker-<host>-<cwd-hash>.json` (or
 * `$CC_STATE_DIR/cc-worker-<host>-<cwd-hash>.json` when the env var is
 * set; mirrors the doorbell `feishu-ws-last-tick` convention).
 *
 * The file holds enough metadata to:
 *   - tell whether the recorded pid is still alive
 *   - report when it started
 *   - report which doorbell URL it's polling (to detect "you started a
 *     worker against a different bridge by accident")
 */

export interface WorkerStateRecord {
  host: string;
  cwd: string;
  pid: number;
  doorbellUrl: string;
  startedAt: number;
  workerId: string;
}

export function resolveStateDir(): string {
  const override = process.env.CC_STATE_DIR;
  if (override && override.trim().length > 0) return resolve(override.trim());
  return join(homedir(), '.postline', 'state');
}

export function workerStateFile(host: string, cwd: string): string {
  const hash = cwdHash(cwd);
  return join(resolveStateDir(), `cc-worker-${sanitiseHost(host)}-${hash}.json`);
}

export function writeWorkerState(rec: WorkerStateRecord): string {
  const path = workerStateFile(rec.host, rec.cwd);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(rec, null, 2));
  return path;
}

export function readWorkerState(host: string, cwd: string): WorkerStateRecord | null {
  const path = workerStateFile(host, cwd);
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, 'utf8');
    const parsed = JSON.parse(raw) as Partial<WorkerStateRecord>;
    if (
      typeof parsed.host !== 'string' ||
      typeof parsed.cwd !== 'string' ||
      typeof parsed.pid !== 'number' ||
      typeof parsed.doorbellUrl !== 'string' ||
      typeof parsed.startedAt !== 'number' ||
      typeof parsed.workerId !== 'string'
    ) {
      return null;
    }
    return {
      host: parsed.host,
      cwd: parsed.cwd,
      pid: parsed.pid,
      doorbellUrl: parsed.doorbellUrl,
      startedAt: parsed.startedAt,
      workerId: parsed.workerId,
    };
  } catch {
    return null;
  }
}

export function clearWorkerState(host: string, cwd: string): void {
  const path = workerStateFile(host, cwd);
  if (existsSync(path)) {
    try {
      unlinkSync(path);
    } catch {
      // best-effort
    }
  }
}

/**
 * Liveness check by pid. Uses signal 0 (POSIX semantics: doesn't send
 * a real signal, just checks the process exists + caller has permission
 * to signal it). Returns true if alive, false if dead or the kill call
 * threw EPERM/ESRCH.
 */
export function isPidAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function cwdHash(cwd: string): string {
  return createHash('sha256').update(cwd, 'utf8').digest('hex').slice(0, 12);
}

function sanitiseHost(host: string): string {
  // Strip filesystem-unfriendly chars so the file name stays portable.
  return host.replace(/[^A-Za-z0-9._-]/g, '_');
}

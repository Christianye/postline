import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  clearWorkerState,
  isPidAlive,
  readWorkerState,
  workerStateFile,
  writeWorkerState,
} from './state.js';

describe('cc-worker state file', () => {
  let tmp: string;
  let prev: string | undefined;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'postline-cc-worker-state-'));
    prev = process.env.CC_STATE_DIR;
    process.env.CC_STATE_DIR = tmp;
  });

  afterEach(() => {
    if (prev === undefined) delete process.env.CC_STATE_DIR;
    else process.env.CC_STATE_DIR = prev;
    rmSync(tmp, { recursive: true, force: true });
  });

  it('write → read round-trip', () => {
    const rec = {
      host: 'mac.local',
      cwd: '/home/dev/postline',
      pid: 1234,
      doorbellUrl: 'http://localhost:9999',
      startedAt: 1_700_000_000_000,
      workerId: 'w_abc12345',
    };
    const path = writeWorkerState(rec);
    expect(path).toContain('cc-worker-mac.local-');
    expect(path.endsWith('.json')).toBe(true);
    const read = readWorkerState(rec.host, rec.cwd);
    expect(read).toEqual(rec);
  });

  it('readWorkerState returns null when file is absent', () => {
    expect(readWorkerState('nope', '/nope')).toBeNull();
  });

  it('readWorkerState returns null on garbage', () => {
    const path = workerStateFile('host', '/cwd');
    writeFileSync(path, 'not json');
    expect(readWorkerState('host', '/cwd')).toBeNull();
  });

  it('readWorkerState returns null on missing fields', () => {
    const path = workerStateFile('host', '/cwd');
    writeFileSync(path, JSON.stringify({ host: 'x', pid: 1 }));
    expect(readWorkerState('host', '/cwd')).toBeNull();
  });

  it('clearWorkerState removes the file (idempotent)', () => {
    writeWorkerState({
      host: 'h',
      cwd: '/c',
      pid: 1,
      doorbellUrl: 'x',
      startedAt: 0,
      workerId: 'w',
    });
    clearWorkerState('h', '/c');
    expect(readWorkerState('h', '/c')).toBeNull();
    // Second call should not throw.
    expect(() => clearWorkerState('h', '/c')).not.toThrow();
  });

  it('different hosts get different state files', () => {
    const a = workerStateFile('hostA', '/cwd');
    const b = workerStateFile('hostB', '/cwd');
    expect(a).not.toBe(b);
  });

  it('different cwds get different state files', () => {
    const a = workerStateFile('host', '/cwdA');
    const b = workerStateFile('host', '/cwdB');
    expect(a).not.toBe(b);
  });

  it('hostnames with filesystem-unsafe chars are sanitised', async () => {
    const { basename } = await import('node:path');
    const path = workerStateFile('weird/name with spaces', '/cwd');
    const base = basename(path);
    expect(base).not.toContain(' ');
    expect(base).not.toContain('/');
    // The hash portion sits at end of the basename; sanitised host
    // appears between the prefix and the hash.
    expect(base).toContain('weird_name_with_spaces');
  });
});

describe('isPidAlive', () => {
  it('returns true for the current process', () => {
    expect(isPidAlive(process.pid)).toBe(true);
  });

  it('returns false for an obviously dead pid', () => {
    // Pid 999_999_999 is virtually never a real process.
    expect(isPidAlive(999_999_999)).toBe(false);
  });

  it('returns false for invalid input', () => {
    expect(isPidAlive(0)).toBe(false);
    expect(isPidAlive(-1)).toBe(false);
    expect(isPidAlive(Number.NaN)).toBe(false);
  });
});

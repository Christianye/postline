import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { canonicalizeCwd, reportingHostname } from './canonicalize.js';

describe('canonicalizeCwd', () => {
  // mkdtempSync may return a path under /tmp that realpath resolves
  // to /private/tmp on macOS. Always compare against realpathed values.
  let dir: string;

  beforeEach(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'postline-canon-')));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns process.cwd() when no git toplevel found', () => {
    const repo = join(dir, 'repo');
    mkdirSync(repo);
    const out = canonicalizeCwd({
      cwd: repo,
      gitToplevelOverride: () => null,
    });
    expect(out).toBe(repo);
  });

  it('honours git toplevel override', () => {
    const sub = join(dir, 'project', 'src');
    const top = join(dir, 'project');
    mkdirSync(sub, { recursive: true });
    const out = canonicalizeCwd({
      cwd: sub,
      gitToplevelOverride: () => top,
    });
    expect(out).toBe(top);
  });

  it('resolves symlinks (realpath)', () => {
    const real = join(dir, 'real');
    const link = join(dir, 'link');
    mkdirSync(real);
    symlinkSync(real, link);
    const out = canonicalizeCwd({
      cwd: link,
      gitToplevelOverride: (d) => d,
    });
    expect(out).toBe(realpathSync(real));
  });

  it('falls back to absolute path when realpath throws', () => {
    const ghost = join(dir, 'does-not-exist');
    const out = canonicalizeCwd({
      cwd: ghost,
      gitToplevelOverride: () => null,
      realpath: () => {
        throw new Error('ENOENT');
      },
    });
    expect(out).toBe(ghost);
  });

  it('preserves case of the resolved path', () => {
    const mixed = join(dir, 'MixedCase');
    mkdirSync(mixed);
    const out = canonicalizeCwd({
      cwd: mixed,
      gitToplevelOverride: () => mixed,
    });
    expect(out).toBe(mixed);
    expect(out).toContain('MixedCase');
  });
});

describe('reportingHostname', () => {
  it('returns a non-empty string', () => {
    const h = reportingHostname();
    expect(typeof h).toBe('string');
    expect(h.length).toBeGreaterThan(0);
  });
});

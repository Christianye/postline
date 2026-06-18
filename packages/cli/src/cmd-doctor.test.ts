import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DoorbellCoordinator,
  type DoorbellServerHandle,
  startDoorbellServer,
} from '@postline/doorbell';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runDoctor } from './cmd-doctor.js';

const TICK_FILENAME = 'feishu-ws-last-tick.json';

describe('cmd-doctor feishu-ws check', () => {
  let tmp: string;
  let prevState: string | undefined;
  let prevConfig: string | undefined;
  let stdoutLines: string[];
  let stderrLines: string[];
  // ReturnType<typeof vi.spyOn> defaults to a generic mock signature that
  // refuses non-`unknown` return types like `never` (process.exit). Loosen
  // to `any` here — vitest's spy types intentionally don't surface the
  // overload set we'd need.
  // biome-ignore lint/suspicious/noExplicitAny: see comment above
  let writeStdoutSpy: any;
  // biome-ignore lint/suspicious/noExplicitAny: see comment above
  let writeStderrSpy: any;
  // biome-ignore lint/suspicious/noExplicitAny: see comment above
  let exitSpy: any;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'postline-doctor-'));
    prevState = process.env.CC_STATE_DIR;
    process.env.CC_STATE_DIR = tmp;
    // Point config loader at a plain-export fixture so checkConfig doesn't
    // fail. We avoid `defineConfig` to keep the fixture from needing a
    // workspace-resolvable import path inside an arbitrary tmpdir.
    prevConfig = process.env.POSTLINE_CONFIG;
    const cfgPath = join(tmp, 'postline.config.mjs');
    writeFileSync(
      cfgPath,
      [
        'export default {',
        "  provider: { name: 'anthropic' },",
        "  model: 'claude-sonnet-4-6',",
        `  memory: { dir: ${JSON.stringify(join(tmp, 'memory'))} },`,
        '  allowlist: { openIds: [] },',
        '  tools: { builtin: [] },',
        '};',
        '',
      ].join('\n'),
    );
    process.env.POSTLINE_CONFIG = cfgPath;

    stdoutLines = [];
    stderrLines = [];
    writeStdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      stdoutLines.push(String(chunk));
      return true;
    });
    writeStderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
      stderrLines.push(String(chunk));
      return true;
    });
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`__exit:${code ?? 0}`);
    }) as never);
  });

  afterEach(() => {
    writeStdoutSpy.mockRestore();
    writeStderrSpy.mockRestore();
    exitSpy.mockRestore();
    if (prevState === undefined) delete process.env.CC_STATE_DIR;
    else process.env.CC_STATE_DIR = prevState;
    if (prevConfig === undefined) delete process.env.POSTLINE_CONFIG;
    else process.env.POSTLINE_CONFIG = prevConfig;
    rmSync(tmp, { recursive: true, force: true });
  });

  function output(): string {
    return stdoutLines.join('') + stderrLines.join('');
  }

  it('lenient: missing tick → warn, exit 0', async () => {
    await runDoctor([]);
    expect(output()).toMatch(/\[warn\] feishu-ws/);
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('strict: missing tick → fail, exit 1', async () => {
    await expect(runDoctor(['--strict'])).rejects.toThrow('__exit:1');
    expect(output()).toMatch(/\[FAIL\] feishu-ws/);
  });

  it('strict: fresh tick → ok, exit 0', async () => {
    writeFileSync(join(tmp, TICK_FILENAME), JSON.stringify({ ts: Date.now() }));
    await runDoctor(['--strict']);
    expect(output()).toMatch(/\[ {2}ok\] feishu-ws\s+last dispatch/);
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('strict: stale tick → fail with age + threshold detail', async () => {
    writeFileSync(join(tmp, TICK_FILENAME), JSON.stringify({ ts: Date.now() - 120_000 }));
    await expect(runDoctor(['--strict'])).rejects.toThrow('__exit:1');
    const out = output();
    expect(out).toMatch(/\[FAIL\] feishu-ws\s+last dispatch \dm.* ago/);
    expect(out).toMatch(/threshold 1m30s/);
  });

  it('lenient: stale tick → warn, exit 0', async () => {
    writeFileSync(join(tmp, TICK_FILENAME), JSON.stringify({ ts: Date.now() - 120_000 }));
    await runDoctor([]);
    expect(output()).toMatch(/\[warn\] feishu-ws\s+last dispatch \dm/);
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('clock skew: future tick → warn even in strict mode', async () => {
    writeFileSync(join(tmp, TICK_FILENAME), JSON.stringify({ ts: Date.now() + 60_000 }));
    await runDoctor(['--strict']);
    expect(output()).toMatch(/\[warn\] feishu-ws\s+tick timestamp is in the future/);
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('--help prints the strict flag description', async () => {
    await runDoctor(['--help']);
    expect(output()).toContain('--strict');
    expect(output()).toContain('feishu-ws liveness tick');
  });
});

describe('cmd-doctor doorbell dispatch check', () => {
  const SECRET = 'POSTLINE_DOORBELL_TEST_SECRET_32_BYTES_OPAQUE';
  let tmp: string;
  let server: DoorbellServerHandle | undefined;
  let coord: DoorbellCoordinator | undefined;
  const saved: Record<string, string | undefined> = {};
  let out: string[];
  // biome-ignore lint/suspicious/noExplicitAny: spy types (see other describe)
  let stdoutSpy: any;
  // biome-ignore lint/suspicious/noExplicitAny: spy types
  let stderrSpy: any;
  // biome-ignore lint/suspicious/noExplicitAny: spy types
  let exitSpy: any;

  function silentLogger() {
    const noop = () => {};
    // biome-ignore lint/suspicious/noExplicitAny: minimal logger stub
    const l: any = { info: noop, warn: noop, error: noop, debug: noop, trace: noop, fatal: noop };
    l.child = () => l;
    return l;
  }

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'postline-doctor-db-'));
    for (const k of ['CC_STATE_DIR', 'POSTLINE_CONFIG', 'CC_DOORBELL_URL', 'CC_DOORBELL_SECRET']) {
      saved[k] = process.env[k];
    }
    process.env.CC_STATE_DIR = tmp;
    // Minimal valid config so checkConfig passes + checkDoorbell's cfg branch
    // doesn't add a doorbell (we drive it purely via env).
    const cfgPath = join(tmp, 'postline.config.mjs');
    writeFileSync(
      cfgPath,
      [
        'export default {',
        "  provider: { name: 'anthropic' },",
        "  model: 'claude-sonnet-4-6',",
        `  memory: { dir: ${JSON.stringify(join(tmp, 'memory'))} },`,
        '  allowlist: { openIds: [] },',
        '  tools: { builtin: [] },',
        '};',
      ].join('\n'),
    );
    process.env.POSTLINE_CONFIG = cfgPath;
    // Fresh tick so feishu-ws doesn't FAIL under --strict and mask the test.
    writeFileSync(join(tmp, 'feishu-ws-last-tick.json'), JSON.stringify({ ts: Date.now() }));
    out = [];
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation((c: unknown) => {
      out.push(String(c));
      return true;
    });
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation((c: unknown) => {
      out.push(String(c));
      return true;
    });
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`__exit:${code ?? 0}`);
    }) as never);
  });

  afterEach(async () => {
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
    exitSpy.mockRestore();
    if (server) await server.close();
    coord?.stop();
    server = undefined;
    coord = undefined;
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(tmp, { recursive: true, force: true });
  });

  async function startServer(): Promise<string> {
    coord = new DoorbellCoordinator({ log: silentLogger() });
    server = await startDoorbellServer({
      coordinator: coord,
      secret: SECRET,
      host: '127.0.0.1',
      port: 0,
      log: silentLogger(),
    });
    return `http://${server.address.host}:${server.address.port}`;
  }

  it('no doorbell configured → ok (dispatch disabled)', async () => {
    await runDoctor([]);
    expect(out.join('')).toMatch(/\[ {2}ok\] doorbell\s+dispatch disabled/);
  });

  it('reachable doorbell with no worker → warn (run cc-worker start)', async () => {
    process.env.CC_DOORBELL_URL = await startServer();
    process.env.CC_DOORBELL_SECRET = SECRET;
    await runDoctor([]);
    expect(out.join('')).toMatch(/\[warn\] doorbell\s+doorbell up.*no worker registered/);
  });

  it('reachable doorbell with a registered worker → ok with count', async () => {
    process.env.CC_DOORBELL_URL = await startServer();
    process.env.CC_DOORBELL_SECRET = SECRET;
    coord?.register({
      cwd: '/repo/acme',
      hostname: 'h1',
      pid: 1,
      agentKind: 'cc',
      registeredAt: Date.now(),
    });
    await runDoctor([]);
    expect(out.join('')).toMatch(/\[ {2}ok\] doorbell\s+doorbell up.*1 worker/);
  });

  it('unreachable doorbell → fail under --strict', async () => {
    process.env.CC_DOORBELL_URL = 'http://127.0.0.1:1'; // nothing listening
    process.env.CC_DOORBELL_SECRET = SECRET;
    await expect(runDoctor(['--strict'])).rejects.toThrow('__exit:1');
    expect(out.join('')).toMatch(/\[FAIL\] doorbell\s+doorbell unreachable/);
  });
});

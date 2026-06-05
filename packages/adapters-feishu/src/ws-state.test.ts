import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  FEISHU_WS_TICK_FILENAME,
  readFeishuWsTick,
  resolveFeishuWsTickPath,
  resolveStateDir,
  writeFeishuWsTick,
} from './ws-state.js';

describe('feishu ws-state', () => {
  let tmp: string;
  let prevEnv: string | undefined;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'postline-ws-state-'));
    prevEnv = process.env.CC_STATE_DIR;
    process.env.CC_STATE_DIR = tmp;
  });

  afterEach(() => {
    if (prevEnv === undefined) delete process.env.CC_STATE_DIR;
    else process.env.CC_STATE_DIR = prevEnv;
    rmSync(tmp, { recursive: true, force: true });
  });

  it('CC_STATE_DIR override wins over the homedir default', () => {
    expect(resolveStateDir()).toBe(tmp);
    expect(resolveFeishuWsTickPath()).toBe(join(tmp, FEISHU_WS_TICK_FILENAME));
  });

  it('write then read round-trips a tick', () => {
    writeFeishuWsTick(1_700_000_000_000);
    const tick = readFeishuWsTick();
    expect(tick).toEqual({ ts: 1_700_000_000_000 });
  });

  it('write creates the parent dir if missing', () => {
    process.env.CC_STATE_DIR = join(tmp, 'nested', 'state');
    writeFeishuWsTick(42);
    const raw = readFileSync(join(tmp, 'nested', 'state', FEISHU_WS_TICK_FILENAME), 'utf8');
    expect(JSON.parse(raw)).toEqual({ ts: 42 });
  });

  it('read returns null when the file is missing', () => {
    expect(readFeishuWsTick()).toBeNull();
  });

  it('read returns null on garbage / non-numeric ts', () => {
    writeFileSync(join(tmp, FEISHU_WS_TICK_FILENAME), 'not json');
    expect(readFeishuWsTick()).toBeNull();
    writeFileSync(join(tmp, FEISHU_WS_TICK_FILENAME), JSON.stringify({ ts: 'oops' }));
    expect(readFeishuWsTick()).toBeNull();
    writeFileSync(join(tmp, FEISHU_WS_TICK_FILENAME), JSON.stringify({}));
    expect(readFeishuWsTick()).toBeNull();
  });

  it('write swallows errors and never throws', () => {
    // Point at an unwritable path (a file, not a directory).
    const blocker = join(tmp, 'blocker');
    writeFileSync(blocker, 'x');
    process.env.CC_STATE_DIR = join(blocker, 'cannot-mkdir');
    expect(() => writeFeishuWsTick(1)).not.toThrow();
  });
});

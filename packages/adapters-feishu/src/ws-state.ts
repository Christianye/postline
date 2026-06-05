import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

/**
 * Lightweight liveness state for the feishu long-poll adapter.
 *
 * The adapter writes a tick every time it dispatches an event from
 * Lark.WSClient. `postline doctor --strict` reads it and fails when the
 * tick is stale, which surfaces the "ws connected but silent" failure
 * mode that an in-process healthcheck otherwise can't see.
 *
 * Path resolution priority:
 *   1. `CC_STATE_DIR` env var (explicit override; useful in containers)
 *   2. `~/.postline/state/`
 *
 * The state file is intentionally NOT in `CC_MEMORY_DIR` — memory is
 * git-tracked and meant to be portable; ws ticks are local-runtime
 * scratch.
 */
export const FEISHU_WS_TICK_FILENAME = 'feishu-ws-last-tick.json';

export function resolveStateDir(): string {
  const override = process.env.CC_STATE_DIR;
  if (override && override.trim().length > 0) return resolve(override.trim());
  return join(homedir(), '.postline', 'state');
}

export function resolveFeishuWsTickPath(): string {
  return join(resolveStateDir(), FEISHU_WS_TICK_FILENAME);
}

export interface FeishuWsTick {
  ts: number;
}

/**
 * Best-effort write — never throw. The bot is the source of truth for
 * "I'm alive"; an fs failure in the tick path must not crash a real
 * dispatch.
 */
export function writeFeishuWsTick(now: number = Date.now()): void {
  try {
    const path = resolveFeishuWsTickPath();
    mkdirSync(dirname(path), { recursive: true });
    const payload: FeishuWsTick = { ts: now };
    writeFileSync(path, JSON.stringify(payload));
  } catch {
    // Swallow: liveness writer must never break event dispatch.
  }
}

/**
 * Read the last tick. Returns `null` if missing or unparsable. Doctor
 * decides what `null` means — lenient: warn, strict: fail.
 */
export function readFeishuWsTick(): FeishuWsTick | null {
  try {
    const path = resolveFeishuWsTickPath();
    if (!existsSync(path)) return null;
    const raw = readFileSync(path, 'utf8');
    const parsed = JSON.parse(raw) as Partial<FeishuWsTick>;
    if (typeof parsed.ts !== 'number' || !Number.isFinite(parsed.ts)) return null;
    return { ts: parsed.ts };
  } catch {
    return null;
  }
}

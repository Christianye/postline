import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface Config {
  provider: 'bedrock';
  region: string;
  model: string;
  fallbacks: readonly string[];
  allowlist: ReadonlySet<string>;
  logLevel: 'silent' | 'error' | 'warn' | 'info' | 'debug';
  memoryDir: string;
}

/**
 * Load config from (in order): ~/.cc-dev/.env on Mac, ~/.cc/env on EC2, then process.env.
 * Missing values fall back to sensible defaults.
 */
export function loadConfig(): Config {
  loadEnvFile([`${homedir()}/.cc-dev/.env`, `${homedir()}/.cc/env`]);

  const allowlist = new Set(
    (process.env.CC_ALLOWLIST_OPEN_IDS ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );

  const primary =
    process.env.CC_PRIMARY_MODEL ?? 'amazon-bedrock/us.anthropic.claude-opus-4-7';
  const fallbacksRaw = process.env.CC_FALLBACK_MODELS ?? '';
  const fallbacks = fallbacksRaw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  return {
    provider: 'bedrock',
    region: process.env.AWS_REGION ?? 'us-west-2',
    model: primary,
    fallbacks,
    allowlist,
    logLevel: (process.env.CC_LOG_LEVEL as Config['logLevel']) ?? 'info',
    memoryDir: process.env.CC_MEMORY_DIR ?? join(homedir(), '.cc', 'memory'),
  };
}

function loadEnvFile(paths: string[]): void {
  for (const path of paths) {
    try {
      const text = readFileSync(path, 'utf8');
      for (const line of text.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eq = trimmed.indexOf('=');
        if (eq < 0) continue;
        const key = trimmed.slice(0, eq).trim();
        let val = trimmed.slice(eq + 1).trim();
        // Strip surrounding quotes if present
        if (
          (val.startsWith('"') && val.endsWith('"')) ||
          (val.startsWith("'") && val.endsWith("'"))
        ) {
          val = val.slice(1, -1);
        }
        if (!(key in process.env)) process.env[key] = val;
      }
      return; // first file wins
    } catch {
      // file missing — continue
    }
  }
}

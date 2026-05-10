import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ProviderSpec } from '@postline/providers';
import type { BuiltinToolId, PostlineConfig } from './types.js';

export interface LoadConfigOpts {
  /** Explicit config file path. If omitted, searches for `postline.config.ts` / `.mjs` / `.js` in cwd. */
  configPath?: string;
  /** Working directory for the search. Default process.cwd(). */
  cwd?: string;
  /** If true, no env fallback; config file is required. */
  strict?: boolean;
}

/**
 * Resolution order:
 *   1. explicit opts.configPath
 *   2. $POSTLINE_CONFIG env
 *   3. ./postline.config.{ts,mjs,js} in cwd
 *   4. env-only fallback (Phase 1 legacy: reads CC_* vars from ~/.cc/env or ~/.cc-dev/.env)
 */
export async function loadPostlineConfig(opts: LoadConfigOpts = {}): Promise<PostlineConfig> {
  const cwd = opts.cwd ?? process.cwd();

  const explicitPath = opts.configPath ?? process.env.POSTLINE_CONFIG ?? findDefaultConfig(cwd);

  if (explicitPath) {
    return await importConfigFile(explicitPath);
  }

  if (opts.strict) {
    throw new Error(
      'no postline.config.{ts,mjs,js} found and POSTLINE_CONFIG not set; ' +
        'strict mode requires an explicit config',
    );
  }

  // Legacy path: compose a config from CC_* env vars.
  loadEnvDotfiles();
  return buildConfigFromEnv();
}

function findDefaultConfig(cwd: string): string | null {
  for (const name of ['postline.config.ts', 'postline.config.mjs', 'postline.config.js']) {
    const p = resolve(cwd, name);
    if (existsSync(p)) return p;
  }
  return null;
}

async function importConfigFile(path: string): Promise<PostlineConfig> {
  const abs = isAbsolute(path) ? path : resolve(process.cwd(), path);
  if (!existsSync(abs)) throw new Error(`config not found: ${abs}`);

  // Node 22+ can strip TS types natively via --experimental-strip-types,
  // which the CLI entry passes. For .js/.mjs, dynamic import works directly.
  const url = pathToFileURL(abs).href;
  const mod = (await import(url)) as { default?: PostlineConfig };
  if (!mod.default) {
    throw new Error(
      `config at ${abs} has no default export — use \`export default defineConfig({...})\``,
    );
  }
  return mod.default;
}

function loadEnvDotfiles(): void {
  for (const path of [`${homedir()}/.cc-dev/.env`, `${homedir()}/.cc/env`]) {
    try {
      const text = readFileSync(path, 'utf8');
      for (const line of text.split('\n')) {
        const t = line.trim();
        if (!t || t.startsWith('#')) continue;
        const eq = t.indexOf('=');
        if (eq < 0) continue;
        const key = t.slice(0, eq).trim();
        let val = t.slice(eq + 1).trim();
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
      // ignore missing file
    }
  }
}

/**
 * Build a PostlineConfig from CC_* env vars. Used when no config file exists.
 * This is the legacy / pre-config-file compatibility path.
 */
function buildConfigFromEnv(): PostlineConfig {
  const openIds = (process.env.CC_ALLOWLIST_OPEN_IDS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const primary = process.env.CC_PRIMARY_MODEL ?? 'amazon-bedrock/us.anthropic.claude-opus-4-7';
  const fallbacks = (process.env.CC_FALLBACK_MODELS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const memoryDir = process.env.CC_MEMORY_DIR ?? `${homedir()}/.cc/memory`;

  const provider: ProviderSpec = {
    name: 'bedrock',
    region: process.env.AWS_REGION ?? 'us-west-2',
  };

  const builtin: BuiltinToolId[] = [
    'echo',
    'web_fetch',
    'fs',
    'memory',
    'github',
    'lark_docs',
    'bash_read',
    'bash',
  ];
  if (process.env.CC_OPENCLAW_TOKEN) builtin.push('openclaw_bridge');

  const cfg: PostlineConfig = {
    provider,
    model: primary,
    fallbacks,
    allowlist: { openIds },
    memory: { dir: memoryDir, gitPush: true },
    tools: {
      builtin,
      options: {
        fs: {
          readAllow: [memoryDir, '/tmp'],
          writeAllow: [memoryDir, '/tmp'],
        },
        bash: { timeoutMs: 30_000 },
        bash_read: { timeoutMs: 30_000 },
        ...(process.env.CC_OPENCLAW_TOKEN
          ? {
              openclaw_bridge: {
                token: process.env.CC_OPENCLAW_TOKEN,
                url: process.env.CC_OPENCLAW_URL ?? 'ws://localhost:18789',
                defaultSessionId: process.env.CC_OPENCLAW_SESSION ?? 'cc-collab',
                ...(process.env.CC_OPENCLAW_BIN ? { bin: process.env.CC_OPENCLAW_BIN } : {}),
              },
            }
          : {}),
      },
    },
    logging: {
      level:
        (process.env.CC_LOG_LEVEL as PostlineConfig['logging'] extends {
          level: infer L;
        }
          ? L
          : never) ?? 'info',
    },
  };

  if (process.env.CC_FEISHU_APP_ID && process.env.CC_FEISHU_APP_SECRET) {
    cfg.feishu = {
      appId: process.env.CC_FEISHU_APP_ID,
      appSecret: process.env.CC_FEISHU_APP_SECRET,
      ...(process.env.CC_FEISHU_BOT_OPEN_ID
        ? { botOpenId: process.env.CC_FEISHU_BOT_OPEN_ID }
        : {}),
      requireMention: true,
    };
  }

  return cfg;
}

/**
 * Runtime validation of a config object — catches obvious errors before wiring.
 * Intentionally lightweight; a full JSON-Schema check is done by the generated
 * schemas/postline.config.schema.json when users want IDE validation for JSON.
 */
export function validateConfig(cfg: PostlineConfig): string[] {
  const errors: string[] = [];
  if (!cfg.provider?.name) errors.push('provider.name is required');
  if (!cfg.model) errors.push('model is required');
  if (!cfg.memory?.dir) errors.push('memory.dir is required');
  if (!cfg.allowlist) errors.push('allowlist.openIds required (may be empty array)');
  if (!cfg.tools?.builtin) errors.push('tools.builtin required (may be empty array)');
  if (cfg.feishu) {
    if (!cfg.feishu.appId) errors.push('feishu.appId is required when feishu section is set');
    if (!cfg.feishu.appSecret)
      errors.push('feishu.appSecret is required when feishu section is set');
  }
  return errors;
}

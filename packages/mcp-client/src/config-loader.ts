import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { McpServerConfig, McpSource } from './types.js';

/**
 * Load servers from Claude Code's ~/.claude.json (mcpServers field).
 * Returns an empty map if the file is missing or has no mcpServers field.
 * Throws only on malformed JSON.
 */
export async function loadClaudeCodeServers(
  configPath: string = join(homedir(), '.claude.json'),
): Promise<Record<string, McpServerConfig>> {
  let raw: string;
  try {
    raw = await readFile(configPath, 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return {};
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`mcp: ${configPath} is not valid JSON: ${(err as Error).message}`);
  }
  if (!parsed || typeof parsed !== 'object') return {};
  const servers = (parsed as { mcpServers?: unknown }).mcpServers;
  if (!servers || typeof servers !== 'object') return {};

  const out: Record<string, McpServerConfig> = {};
  for (const [name, entry] of Object.entries(servers as Record<string, unknown>)) {
    const cfg = coerceServerConfig(entry);
    if (cfg) out[name] = cfg;
  }
  return out;
}

function coerceServerConfig(v: unknown): McpServerConfig | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  if (typeof o.command !== 'string' || o.command.length === 0) return null;
  if (o.type !== undefined && o.type !== 'stdio') return null; // skip sse/ws/http
  const cfg: McpServerConfig = { command: o.command };
  if (Array.isArray(o.args) && o.args.every((x) => typeof x === 'string')) {
    cfg.args = o.args as readonly string[];
  }
  if (o.env && typeof o.env === 'object') {
    cfg.env = o.env as Record<string, string | undefined>;
  }
  if (typeof o.cwd === 'string') cfg.cwd = o.cwd;
  return cfg;
}

/**
 * Merge inline + claude-code sources per the source flag. Inline wins on conflict.
 */
export async function resolveServers(opts: {
  source?: McpSource;
  servers?: Readonly<Record<string, McpServerConfig>>;
  claudeConfigPath?: string;
}): Promise<Record<string, McpServerConfig>> {
  const source = opts.source ?? 'both';
  const inline = opts.servers ? { ...opts.servers } : {};
  if (source === 'postline') return inline;

  const fromClaude = await loadClaudeCodeServers(opts.claudeConfigPath);
  if (source === 'claude-code') return fromClaude;

  // both — inline wins
  return { ...fromClaude, ...inline };
}

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
  const type = o.type;

  // HTTP / SSE transports: need a `url`, optionally `headers`.
  if (type === 'http' || type === 'streamable-http' || type === 'sse') {
    if (typeof o.url !== 'string' || o.url.length === 0) return null;
    const httpLike: {
      type: 'http' | 'streamable-http' | 'sse';
      url: string;
      headers?: Record<string, string>;
    } = { type: type as 'http' | 'streamable-http' | 'sse', url: o.url };
    if (o.headers && typeof o.headers === 'object') {
      const h: Record<string, string> = {};
      for (const [k, v] of Object.entries(o.headers as Record<string, unknown>)) {
        if (typeof v === 'string') h[k] = v;
      }
      if (Object.keys(h).length > 0) httpLike.headers = h;
    }
    return httpLike as McpServerConfig;
  }

  // stdio (default when type is absent).
  if (type !== undefined && type !== 'stdio') return null; // unknown transport
  if (typeof o.command !== 'string' || o.command.length === 0) return null;
  const stdio: {
    type?: 'stdio';
    command: string;
    args?: readonly string[];
    env?: Record<string, string | undefined>;
    cwd?: string;
  } = { command: o.command };
  if (Array.isArray(o.args) && o.args.every((x) => typeof x === 'string')) {
    stdio.args = o.args as readonly string[];
  }
  if (o.env && typeof o.env === 'object') {
    stdio.env = o.env as Record<string, string | undefined>;
  }
  if (typeof o.cwd === 'string') stdio.cwd = o.cwd;
  return stdio as McpServerConfig;
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

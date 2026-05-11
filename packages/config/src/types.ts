import type { McpToolsOptions } from '@postline/mcp-client';
import type { ProviderSpec } from '@postline/providers';

/**
 * Top-level config for a postline deployment.
 * Users author this as TypeScript via `defineConfig({...})` in postline.config.ts,
 * or as JSON using the schema at schemas/postline.config.schema.json.
 */
export interface PostlineConfig {
  /** Which LLM provider to use, plus its per-provider options. */
  provider: ProviderSpec;

  /** Primary model id (provider-prefixed ok). e.g. `amazon-bedrock/us.anthropic.claude-opus-4-7`. */
  model: string;

  /** Model ids to try after the primary fails. */
  fallbacks?: readonly string[];

  /** Inference knobs; defaults are sensible for Claude. */
  inference?: {
    /** Max output tokens per response. Default 8192. */
    maxTokens?: number;
    /** Temperature; leave undefined for provider default. */
    temperature?: number;
  };

  /** Identity-based access control. Empty list means "anyone can trigger read tools". */
  allowlist: {
    /** Feishu / Lark open_ids that may trigger write/dangerous tools. */
    openIds: readonly string[];
  };

  /** Memory directory + git push policy. */
  memory: {
    /** Absolute path. A git repo (or about to be). */
    dir: string;
    /** If true, memory_write commits+pushes after every write. Default true. */
    gitPush?: boolean;
  };

  /** Feishu/Lark channel configuration. Omit to disable feishu. */
  feishu?: {
    appId: string;
    appSecret: string;
    /** Optional; auto-fetched via /bot/v3/info if absent. */
    botOpenId?: string;
    /** If true, only @ messages in groups trigger; DMs always trigger. Default true. */
    requireMention?: boolean;
  };

  /** Which built-in tools to load. Each id maps to a factory + options. */
  tools: {
    /**
     * IDs of built-in tools to enable. See packages/tools-builtin for the full list.
     * Order doesn't matter except for display.
     */
    builtin: readonly BuiltinToolId[];
    /** Per-tool configuration, keyed by tool id. All fields optional. */
    options?: ToolOptions;
    /**
     * Model Context Protocol (MCP) client configuration. Omit to disable.
     * When set, postline spawns the declared stdio MCP servers at startup,
     * lists their tools, and exposes them to the model as `mcp_<server>_<tool>`
     * with the risk tier in `riskDefault` (or `riskOverrides[name]` if set).
     */
    mcp?: McpToolsOptions;
  };

  /** Observability. */
  logging?: {
    /** pino level. Default 'info'. */
    level?: 'silent' | 'error' | 'warn' | 'info' | 'debug' | 'trace';
  };
}

/**
 * The set of built-in tool ids recognized by postline.
 * Keep in sync with packages/tools-builtin/src/register.ts.
 */
export type BuiltinToolId =
  | 'echo'
  | 'web_fetch'
  | 'fs'
  | 'memory'
  | 'github'
  | 'lark_docs'
  | 'feishu_send'
  | 'bash'
  | 'bash_read';

export interface ToolOptions {
  bash?: {
    /** Per-call timeout in ms. Default 60_000. */
    timeoutMs?: number;
    /** Max stdout+stderr bytes returned to the model. Default 64KB. */
    maxOutputBytes?: number;
  };
  bash_read?: {
    timeoutMs?: number;
    maxOutputBytes?: number;
  };
  fs?: {
    /** Absolute paths the agent may read from. */
    readAllow?: readonly string[];
    /** Subset of readAllow that is also writable. */
    writeAllow?: readonly string[];
    maxReadBytes?: number;
  };
  web_fetch?: {
    maxBytes?: number;
    timeoutMs?: number;
    hostDeny?: readonly string[];
  };
  memory?: {
    gitPush?: boolean;
    gitTimeoutMs?: number;
  };
  github?: {
    timeoutMs?: number;
    maxOutputBytes?: number;
  };
  lark_docs?: {
    maxBytes?: number;
    timeoutMs?: number;
  };
  feishu_send?: {
    /** Hard allowlist of chat_ids / open_ids this tool may target. Empty = tool refuses all sends. */
    sendAllowlist: readonly string[];
    /** Messages/minute/target. Default 5. */
    ratePerMin?: number;
    /** Max text length. Default 4500 chars. */
    maxChars?: number;
  };
}

/**
 * Identity function that gives users type hints when authoring postline.config.ts.
 * Usage:
 *   import { defineConfig } from '@postline/config';
 *   export default defineConfig({ provider: { name: 'bedrock' }, ... });
 */
export function defineConfig(c: PostlineConfig): PostlineConfig {
  return c;
}

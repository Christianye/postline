import type { McpToolsOptions } from '@postline/mcp-client';
import type { ProviderSpec } from '@postline/providers';
import type { SkillLoaderOptions } from '@postline/skill-loader';

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

  /**
   * Optional model-routing knob. When `enabled`, the host classifies the
   * inbound text as "trivial" or "non-trivial" before each turn and
   * routes trivial queries (greetings, short questions, length under
   * `trivialMaxChars`, no tool-trigger keywords) to `smallModel` instead
   * of the primary model. Cost-saving for high-frequency cheap queries
   * (10x+ cheaper on haiku vs opus); has no effect when `enabled: false`.
   *
   * Decision is conservative: anything ambiguous routes to the primary
   * model. False positive (primary used on trivial) just costs slightly
   * more; false negative (small model on a hard query) degrades answer
   * quality, so we err toward the primary.
   */
  routing?: {
    enabled: boolean;
    /** Model id to use for trivial queries. Default `amazon-bedrock/global.anthropic.claude-haiku-4-5-20251001-v1:0`. */
    smallModel?: string;
    /** Inbound text length cap for "trivial" classification. Default 50. */
    trivialMaxChars?: number;
  };

  /** Inference knobs; defaults are sensible for Claude. */
  inference?: {
    /** Max output tokens per response. Default 8192. */
    maxTokens?: number;
    /** Temperature; leave undefined for provider default. */
    temperature?: number;
    /**
     * Extended-thinking (adaptive reasoning) configuration. When
     * `enabled: true` the provider asks the model to emit a thinking block
     * before its visible answer; the host streams thinking deltas to a UI
     * hook for visibility, but does NOT persist them — each turn's
     * reasoning is independent.
     *
     * Adaptive mode is required by Claude Opus 4.7+ (older `enabled` mode
     * with `budget_tokens` is rejected). Effort is soft guidance — `'high'`
     * (default) means always think; `'low'` lets the model skip thinking
     * for trivial queries; `'max'` is uncapped (Opus 4.6 only).
     *
     * Cost: thinking tokens count against billed output (in addition to
     * the visible answer tokens), but no manual budget knob is needed.
     */
    thinking?: {
      enabled: boolean;
      effort?: 'low' | 'medium' | 'high' | 'max';
    };
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

  /**
   * Conversation-history persistence. Omit to use the default in-memory
   * store (fine for `pnpm chat`; wipes on every process restart).
   *
   * Set `{ kind: 'fs', dir: '...' }` to persist each conversation as a
   * JSONL file under `dir`. Recommended for 24/7 feishu deployments — a
   * `systemctl restart cc` won't lose in-flight context.
   */
  history?: { kind: 'memory' } | { kind: 'fs'; dir: string };

  /**
   * Per-turn token/cost telemetry. Omit to log usage to stdout/logs only.
   * Set `{ kind: 'fs', dir: '...' }` to additionally append a JSONL entry
   * per provider call to `<dir>/usage.jsonl`. Consumed by `postline stats`.
   */
  usage?: { kind: 'none' } | { kind: 'fs'; dir: string };

  /** Feishu/Lark channel configuration. Omit to disable feishu. */
  feishu?: {
    appId: string;
    appSecret: string;
    /** Optional; auto-fetched via /bot/v3/info if absent. */
    botOpenId?: string;
    /** If true, only @ messages in groups trigger; DMs always trigger. Default true. */
    requireMention?: boolean;
    /**
     * Live-typing mode. When enabled, the bot sends a seed message on first
     * text delta and edits it in place as the model streams. Debounced at
     * `streamingDebounceMs` (default 250ms) to stay well under feishu's rate
     * limit. Falls back to one-shot send on any edit failure. Default false.
     */
    streaming?: boolean;
    /** Minimum ms between streaming edits. Default 250. */
    streamingDebounceMs?: number;
    /**
     * Approval-card click policy. Restricts who may approve/deny a pending
     * dangerous-tool action triggered via card buttons or `/approve`/`/deny`
     * slash commands.
     */
    approval?: {
      /**
       * If true (default), only the user who triggered the action can
       * approve/deny it. Other allowlist members receive a "not your action"
       * toast. Set false to revert to the legacy behaviour where any
       * allowlist member can resolve any pending action.
       */
      requesterOnly?: boolean;
      /**
       * Open_ids that may approve/deny ANY pending action regardless of
       * `requesterOnly`. Useful for an oncall override in shared chats.
       * Default `[]`. Each override is logged as `feishu_approval_override`.
       */
      admins?: readonly string[];
    };
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
    /**
     * Claude Code skill loader. Omit or set `enabled: false` to disable.
     * When enabled, postline walks `dir` (default `~/.claude/skills`) and
     * exposes each skill as a `skill_<id>` tool whose body is the SKILL.md
     * guide. Skills are also advertised in the system prompt so the model
     * picks the right one when the user's request matches.
     */
    skills?: ({ enabled: true } & SkillLoaderOptions) | { enabled: false };
  };

  /** Observability. */
  logging?: {
    /** pino level. Default 'info'. */
    level?: 'silent' | 'error' | 'warn' | 'info' | 'debug' | 'trace';
  };

  /**
   * Doorbell server (PR-DB-1+): the HTTP surface CC workers register
   * against. Omit or set `enabled: false` to disable the entire doorbell
   * subsystem. When enabled, runFeishu() spins up the server bound to
   * 127.0.0.1 by default; SSM port-forwarding from the operator's Mac
   * provides reachability. See `docs/designs/doorbell.md` §6.1.
   */
  doorbell?: {
    /** Master toggle. Default false. */
    enabled?: boolean;
    /** Listen host. Default 127.0.0.1 (no public ingress). */
    host?: string;
    /** Listen port. Default 9999. */
    port?: number;
    /** 32+ char shared secret (env-injected; never write a literal here). */
    secret: string;
    /**
     * Cap of queued tasks per cwd. 11th request gets HTTP 429 (D07).
     * Default 10.
     */
    queueMax?: number;
    /** Long-poll hold, ms. Default 30_000. */
    longPollTimeoutMs?: number;
    /** HMAC ts skew window, ms. Default 60_000. */
    hmacWindowMs?: number;
    /** Heartbeat sweep interval ms. Default 60_000. */
    sweepIntervalMs?: number;
    /** Worker stale threshold ms. Default 60_000. */
    staleThresholdMs?: number;
    /**
     * If set, on every first-time-hostname-seen registration the bridge
     * sends a Feishu DM to this open_id with the hostname, workerId,
     * cwd, pid. Per design §6.2 audit.
     */
    auditFeishuReceiverOpenId?: string;
  };

  /**
   * Bridge-side notifications postline can fire on its own (i.e. without a
   * model-driven turn). All entries default off when not set.
   */
  notify?: {
    /**
     * Background poller that watches design-doc PRs (paths under
     * `watchPaths`) and pushes a one-line Feishu DM to the operator on
     * every new review comment. Helps reframed-postline (no embedded LLM)
     * still surface design-review activity proactively. See
     * `protocol_cc_mailbox.md` "Design-doc review push to the operator" for the
     * cross-CC rationale and message-shape contract.
     */
    designReviewPush?: {
      /** Master toggle. Default false. */
      enabled?: boolean;
      /** Owner/repo to watch. e.g. `Christianye/postline`. */
      repo: string;
      /** Path prefixes that mark a PR as a design-doc review. Default ["docs/designs/"]. */
      watchPaths?: readonly string[];
      /** Poll interval in milliseconds. Default 300_000 (5 minutes). */
      pollIntervalMs?: number;
      /** open_id (`ou_...`) of the operator to ping. Required. */
      receiverOpenId: string;
      /**
       * Persisted dedupe state file. Default
       * `~/.postline/state/design-review-pushed.json` (or
       * `$CC_STATE_DIR/design-review-pushed.json` if that env var is set).
       */
      stateFilePath?: string;
    };
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
  | 'bash_read'
  | 'postline_stats'
  | 'history_search';

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

import type { Tool } from '@postline/core';
import { type BashToolOptions, createBashReadTool, createBashTool } from './bash.js';
import { createEchoTool } from './echo.js';
import { type FeishuSendOptions, createFeishuSendTool } from './feishu-send.js';
import { type FsToolsOptions, createFsTools } from './fs.js';
import { type GithubToolOptions, createGithubTools } from './github.js';
import { type LarkDocsOptions, createLarkDocsTools } from './lark-docs.js';
import { type MemoryToolsOptions, createMemoryTools } from './memory.js';
import { createPostlineStatsTool } from './postline-stats.js';
import { type WebFetchToolOptions, createWebFetchTool } from './web-fetch.js';

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
  | 'postline_stats';

/**
 * Per-tool instantiation options. Opaque to the registry — each tool's factory
 * knows how to interpret its own slot.
 */
export interface BuiltinToolOptions {
  echo?: Record<string, never>;
  web_fetch?: WebFetchToolOptions;
  fs?: FsToolsOptions;
  memory?: Partial<MemoryToolsOptions>;
  github?: GithubToolOptions;
  lark_docs?: Partial<LarkDocsOptions>;
  feishu_send?: {
    /** Hard allowlist of chat_ids / open_ids. Empty = tool refuses all sends. */
    sendAllowlist: readonly string[];
    /** Messages/minute/target. Default 5. */
    ratePerMin?: number;
    /** Max text length. Default 4500. */
    maxChars?: number;
  };
  bash?: BashToolOptions;
  bash_read?: BashToolOptions;
  postline_stats?: Record<string, never>;
}

/**
 * Shared context a tool factory may need at instantiation (not the same as
 * ToolContext which is per-call).
 */
export interface ToolBuildContext {
  /** Required if feishu (for lark_docs). Can be undefined if lark_docs not used. */
  feishu?: { appId: string; appSecret: string };
  /** Path to memory repo, used by memory tools. */
  memoryDir?: string;
  /** Absolute path to history dir, passed to postline_stats. */
  historyDir?: string;
  /** Absolute path to usage dir, passed to postline_stats. */
  usageDir?: string;
  /** Live getter for pending-approval count; used by postline_stats health action. */
  pendingCountFn?: () => number;
  /** Epoch ms when the process started; used by postline_stats uptime report. */
  processStartedAtMs?: number;
}

/**
 * Instantiate the requested built-in tool ids into concrete Tool[].
 * Unknown ids throw; missing context dependencies throw.
 */
export function createBuiltinTools(
  ids: readonly BuiltinToolId[],
  options: BuiltinToolOptions = {},
  ctx: ToolBuildContext = {},
): Tool[] {
  const seen = new Set<string>();
  const out: Tool[] = [];

  for (const id of ids) {
    if (seen.has(id)) {
      throw new Error(`duplicate tool id: ${id}`);
    }
    seen.add(id);

    const made = instantiateOne(id, options, ctx);
    for (const t of made) out.push(t);
  }
  return out;
}

function instantiateOne(
  id: BuiltinToolId,
  opts: BuiltinToolOptions,
  ctx: ToolBuildContext,
): Tool[] {
  switch (id) {
    case 'echo':
      return [createEchoTool()];
    case 'web_fetch':
      return [createWebFetchTool(opts.web_fetch ?? {})];
    case 'fs':
      return createFsTools(opts.fs ?? {});
    case 'memory': {
      if (!ctx.memoryDir) {
        throw new Error("tool 'memory' requires ctx.memoryDir (config.memory.dir)");
      }
      return createMemoryTools({
        dir: ctx.memoryDir,
        ...(opts.memory ?? {}),
      });
    }
    case 'github':
      return createGithubTools(opts.github ?? {});
    case 'lark_docs': {
      if (!ctx.feishu) {
        throw new Error("tool 'lark_docs' requires ctx.feishu (config.feishu.appId + appSecret)");
      }
      return createLarkDocsTools({
        appId: ctx.feishu.appId,
        appSecret: ctx.feishu.appSecret,
        ...(opts.lark_docs ?? {}),
      });
    }
    case 'feishu_send': {
      if (!ctx.feishu) {
        throw new Error("tool 'feishu_send' requires ctx.feishu (config.feishu.appId + appSecret)");
      }
      const optSlot = opts.feishu_send;
      if (!optSlot) {
        throw new Error(
          "tool 'feishu_send' requires tools.options.feishu_send.sendAllowlist " +
            '(explicit opt-in list of chat_ids / open_ids allowed as send targets)',
        );
      }
      const sendOpts: FeishuSendOptions = {
        appId: ctx.feishu.appId,
        appSecret: ctx.feishu.appSecret,
        sendAllowlist: optSlot.sendAllowlist,
        ...(optSlot.ratePerMin !== undefined ? { ratePerMin: optSlot.ratePerMin } : {}),
        ...(optSlot.maxChars !== undefined ? { maxChars: optSlot.maxChars } : {}),
      };
      return [createFeishuSendTool(sendOpts)];
    }
    case 'bash':
      return [createBashTool(opts.bash ?? {})];
    case 'bash_read':
      return [createBashReadTool(opts.bash_read ?? {})];
    case 'postline_stats':
      return [
        createPostlineStatsTool({
          ...(ctx.memoryDir !== undefined ? { memoryDir: ctx.memoryDir } : {}),
          ...(ctx.historyDir !== undefined ? { historyDir: ctx.historyDir } : {}),
          ...(ctx.usageDir !== undefined ? { usageDir: ctx.usageDir } : {}),
          ...(ctx.pendingCountFn !== undefined ? { pendingCountFn: ctx.pendingCountFn } : {}),
          ...(ctx.processStartedAtMs !== undefined
            ? { processStartedAtMs: ctx.processStartedAtMs }
            : {}),
        }),
      ];
    default: {
      const _exhaustive: never = id;
      throw new Error(`unknown builtin tool id: ${JSON.stringify(_exhaustive)}`);
    }
  }
}

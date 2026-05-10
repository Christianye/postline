/**
 * postline.config.ts — edit this and rename to `postline.config.ts` (drop `.example`).
 *
 * See docs/CONFIG.md for a full reference (WIP).
 *
 * Required env vars at runtime:
 *   - AWS credentials (if provider = 'bedrock'), or
 *   - ANTHROPIC_API_KEY (if provider = 'anthropic')
 *   - POSTLINE_FEISHU_APP_SECRET — override for inline appSecret below if you
 *     prefer not to put secrets in this file
 */
import { defineConfig } from '@postline/config';

export default defineConfig({
  // ----- Which LLM provider + which model ------------------------------------
  provider: { name: 'bedrock', region: 'us-west-2' },
  // For Anthropic API instead:
  // provider: { name: 'anthropic' },  // reads ANTHROPIC_API_KEY

  model: 'amazon-bedrock/us.anthropic.claude-opus-4-7',
  fallbacks: [
    'amazon-bedrock/global.anthropic.claude-sonnet-4-6',
    'amazon-bedrock/us.anthropic.claude-opus-4-6-v1',
  ],

  // ----- Who can trigger write/dangerous tools? ------------------------------
  // Leave empty to make CC read-only for everyone.
  allowlist: {
    openIds: [
      // 'ou_xxxxxxxxxxxxxxxxxxxxxxxxxxx',  // your feishu open_id
    ],
  },

  // ----- Memory: a git-backed directory CC can read + write ------------------
  memory: {
    dir: `${process.env.HOME}/.postline/memory`,
    gitPush: true, // auto-push after every memory_write
  },

  // ----- Feishu channel ------------------------------------------------------
  // Remove this block to disable the feishu adapter.
  feishu: {
    appId: 'cli_xxxxxxxxxxxxxxxx',
    // Prefer env for the secret; leave this as empty string if setting via env.
    appSecret: process.env.POSTLINE_FEISHU_APP_SECRET ?? '',
    requireMention: true, // only respond in groups when @-ed (DMs always respond)
  },

  // ----- Built-in tools to load ---------------------------------------------
  tools: {
    builtin: [
      'echo',
      'web_fetch',
      'fs',
      'memory',
      'github',
      'lark_docs',
      'bash_read', // auto-approved read-only shell
      'bash', // state-modifying shell (requires /approve)
      // 'openclaw_bridge',  // uncomment if you have openclaw agent
    ],
    options: {
      bash: { timeoutMs: 30_000 },
      bash_read: { timeoutMs: 30_000 },
      fs: {
        readAllow: [`${process.env.HOME}/.postline/memory`, '/tmp'],
        writeAllow: [`${process.env.HOME}/.postline/memory`, '/tmp'],
      },
      web_fetch: { maxBytes: 2 * 1024 * 1024, timeoutMs: 20_000 },
    },
  },

  logging: { level: 'info' },
});

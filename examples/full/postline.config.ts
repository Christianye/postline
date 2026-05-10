/**
 * Full-featured postline config — equivalent to the author's production EC2 setup.
 *
 * Enables every built-in tool, uses Bedrock (with graceful model fallback),
 * git-pushes memory after every write, and requires a feishu open_id allowlist
 * for any write/dangerous tool call.
 *
 * Assumes:
 *   - You're on AWS (EC2 IAM role / AWS_PROFILE) with Bedrock access
 *   - `gh auth status` passes (for github tools)
 *   - `~/.ssh/id_ed25519` can push to your memory git repo
 *   - POSTLINE_FEISHU_APP_SECRET is in env (not committed)
 */
import { defineConfig } from '@postline/config';

const memoryDir = `${process.env.HOME}/.postline/memory`;

export default defineConfig({
  provider: { name: 'bedrock', region: 'us-west-2' },
  model: 'amazon-bedrock/us.anthropic.claude-opus-4-7',
  fallbacks: [
    'amazon-bedrock/global.anthropic.claude-sonnet-4-6',
    'amazon-bedrock/us.anthropic.claude-opus-4-6-v1',
    'amazon-bedrock/global.anthropic.claude-haiku-4-5-20251001-v1:0',
  ],

  allowlist: {
    openIds: [
      // Add your feishu open_id(s) here. Users NOT in this list still get
      // conversation + read tools, but cannot trigger write/dangerous actions.
      'ou_xxxxxxxxxxxxxxxxxxxxxxxxxxx',
    ],
  },

  memory: {
    dir: memoryDir,
    gitPush: true, // auto-commit + push after every memory_write
  },

  feishu: {
    appId: 'cli_xxxxxxxxxxxxxxxx',
    appSecret: process.env.POSTLINE_FEISHU_APP_SECRET ?? '',
    requireMention: true,
  },

  tools: {
    builtin: [
      'echo',
      'web_fetch',
      'fs',
      'memory',
      'github',
      'lark_docs',
      'bash_read',
      'bash',
      // 'openclaw_bridge',  // uncomment if you also run openclaw on the same host
    ],
    options: {
      bash: { timeoutMs: 30_000 },
      bash_read: { timeoutMs: 30_000 },
      fs: {
        readAllow: [memoryDir, '/tmp', `${process.env.HOME}/projects`],
        writeAllow: [memoryDir, '/tmp'],
      },
      web_fetch: { maxBytes: 2 * 1024 * 1024, timeoutMs: 20_000 },
      memory: { gitPush: true },
    },
  },

  logging: { level: 'info' },
});

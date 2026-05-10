/**
 * Minimal postline config — proves the bot runs.
 *
 * Starts a feishu bot with:
 *   - Anthropic API (ANTHROPIC_API_KEY env)
 *   - claude-opus-4-7 with sonnet fallback
 *   - Only echo + bash_read tools (read-only, no approvals needed)
 *   - Empty allowlist (anyone can chat, nobody can trigger write/dangerous tools)
 *
 * Prerequisites:
 *   export ANTHROPIC_API_KEY=sk-ant-xxx
 *   export POSTLINE_FEISHU_APP_SECRET=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
 */
import { defineConfig } from '@postline/config';

export default defineConfig({
  provider: { name: 'anthropic' },
  model: 'anthropic/claude-opus-4-7',
  fallbacks: ['anthropic/claude-sonnet-4-6'],

  allowlist: { openIds: [] },

  memory: {
    dir: `${process.env.HOME}/.postline-minimal/memory`,
    gitPush: false,
  },

  feishu: {
    appId: 'cli_xxxxxxxxxxxxxxxx',
    appSecret: process.env.POSTLINE_FEISHU_APP_SECRET ?? '',
  },

  tools: {
    builtin: ['echo', 'bash_read'],
  },
});

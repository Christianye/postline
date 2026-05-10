/**
 * examples/daily-report — a config tuned for scheduled workflows.
 *
 * Enables only what daily-report.sh needs:
 *   - gh_query   → read github PR / issue activity
 *   - bash_read  → inspect local git state if needed
 *   - feishu_send → push the summary into your status group
 *
 * No chat-oriented tools (no fs, no memory) — keep the surface small so the
 * model can't wander off task during an unattended run.
 */
import { defineConfig } from '@postline/config';

export default defineConfig({
  provider: { name: 'anthropic' },
  model: 'anthropic/claude-sonnet-4-6', // sonnet is plenty for summary work

  // Unattended runs: no allowlist writes matter here because `postline ask`
  // uses a synthetic user id which we'll pass on the CLI (--user).
  allowlist: { openIds: [] },

  memory: {
    dir: `${process.env.HOME}/.postline-daily-report/memory`,
    gitPush: false,
  },

  // `ask` doesn't need the feishu channel to be LIVE — it just needs the
  // credentials so feishu_send can POST a message.
  feishu: {
    appId: 'cli_xxxxxxxxxxxxxxxx',
    appSecret: process.env.POSTLINE_FEISHU_APP_SECRET ?? '',
  },

  tools: {
    // `github` expands into gh_query (read) + gh_action (write). For a daily
    // report we mostly use gh_query; gh_action is harmless to load because it
    // requires allowlist to be triggered (and we pass an empty allowlist).
    builtin: ['github', 'bash_read', 'feishu_send'],
    options: {
      feishu_send: {
        // Put the chat_id of your status group / on-call DM here.
        // Grab it via `gh_query` after the bot is added, or feishu admin console.
        sendAllowlist: [
          'oc_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx', // #status group
        ],
        ratePerMin: 3,
      },
      bash_read: { timeoutMs: 30_000 },
      github: { timeoutMs: 45_000 },
    },
  },

  logging: { level: 'info' },
});

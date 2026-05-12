/**
 * postline.config.ts — edit this and rename to `postline.config.ts` (drop `.example`).
 *
 * Full reference: docs/CONFIG.md
 *
 * Required env vars at runtime:
 *   - AWS credentials (if provider = 'bedrock'), or
 *   - ANTHROPIC_API_KEY (if provider = 'anthropic')
 *   - POSTLINE_FEISHU_APP_SECRET — override for inline appSecret below if you
 *     prefer not to put secrets in this file
 *
 * Optional env vars are per-MCP-server (declared via `tools.mcp.servers[*].env`
 * or inherited from `~/.claude.json`). Skills need no env vars.
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
  // Uncomment to enable the feishu adapter. `pnpm chat` (the local REPL) does
  // NOT need this block — it only matters for `pnpm start` / `postline feishu`.
  // feishu: {
  //   appId: 'cli_xxxxxxxxxxxxxxxx',
  //   appSecret: process.env.POSTLINE_FEISHU_APP_SECRET ?? '',
  //   requireMention: true, // only respond in groups when @-ed (DMs always respond)
  // },

  // ----- Built-in tools to load ---------------------------------------------
  // This starter set works with `pnpm chat` (no feishu needed). To enable the
  // feishu doc reader, uncomment the `feishu` block above and add `'lark_docs'`
  // to the list below. See docs/TOOLS.md for the full catalogue.
  tools: {
    builtin: [
      'echo',
      'web_fetch',
      'fs',
      'memory',
      'github',
      'bash_read', // auto-approved read-only shell
      'bash', // state-modifying shell (requires /approve)
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

    // ----- Model Context Protocol (MCP) — optional ----------------------------
    // Spawn stdio MCP servers at startup and expose their tools to Claude as
    // `mcp_<server>_<tool>`. See docs/TOOLS.md#mcp-model-context-protocol-client.
    //
    // postline reads Claude Code / Claude Desktop's ~/.claude.json by default
    // (source: 'both'), so MCP servers you've already registered there work
    // out of the box. If you don't use Claude Code, set `source: 'postline'`
    // and declare servers inline — or just leave the whole block commented
    // out. An empty / missing config is not an error.
    //
    // Default risk tier is `dangerous` (every call wants `/approve`). Drop
    // known-safe tools to `read` via `riskOverrides` to skip the gate.
    //
    // mcp: {
    //   source: 'both', // 'postline' | 'claude-code' | 'both' (default)
    //   // Inline definitions (win on name conflict):
    //   servers: {
    //     // fs: {
    //     //   command: 'npx',
    //     //   args: ['-y', '@modelcontextprotocol/server-filesystem', '/tmp'],
    //     // },
    //   },
    //   riskDefault: 'dangerous',
    //   riskOverrides: {
    //     // 'mcp_fs_read_file': 'read',
    //   },
    // },

    // ----- Claude Code skills — optional --------------------------------------
    // Skills are `~/.claude/skills/<name>/SKILL.md` files in the format
    // Claude Code / Claude Desktop use. Each one becomes a read-tier tool
    // `skill_<id>` whose body is the skill guide; the model picks the right
    // skill based on its description. See docs/TOOLS.md#claude-code-skills.
    //
    // If you don't use Claude Code and have no ~/.claude/skills/ directory,
    // leave this disabled (or omit the key entirely).
    //
    // skills: {
    //   enabled: true,
    //   // dir: `${process.env.HOME}/.claude/skills`, // default
    //   // include: ['commit-smart', 'review'], // opt-in subset
    //   // exclude: ['experimental-thing'],
    // },
  },

  logging: { level: 'info' },
});

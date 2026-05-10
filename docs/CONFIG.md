# Config reference

Full reference for `postline.config.ts`. The type is exported from `@postline/config` as `PostlineConfig`.

## Loading

`loadPostlineConfig()` resolves in this order:

1. `opts.configPath` (explicit)
2. `$POSTLINE_CONFIG` env var (path)
3. `postline.config.{ts,mjs,js}` in the current working directory
4. **Env fallback** — reads `CC_*` variables from `~/.cc-dev/.env` or `~/.cc/env` dotfiles and builds a Bedrock-flavoured config (legacy compatibility path)

The `.ts` variant requires Node 22+ with `--experimental-strip-types` (automatic via the `postline` bin).

## Schema

```ts
import { defineConfig } from '@postline/config';

export default defineConfig({
  provider: { name: 'bedrock' | 'anthropic', ...providerOptions },
  model: string,
  fallbacks?: string[],
  inference?: { maxTokens?: number; temperature?: number },
  allowlist: { openIds: string[] },
  memory: { dir: string; gitPush?: boolean },
  feishu?: {
    appId: string;
    appSecret: string;
    botOpenId?: string;
    requireMention?: boolean;  // default true
  },
  tools: {
    builtin: BuiltinToolId[],
    options?: ToolOptions,
  },
  logging?: { level?: 'silent' | 'error' | 'warn' | 'info' | 'debug' | 'trace' },
});
```

## Fields in detail

### provider

Required. Tagged union — `name` picks the implementation:

```ts
// AWS Bedrock (credentials from env / IMDS / AWS profile)
provider: { name: 'bedrock', region: 'us-west-2', timeoutMs: 180_000 }

// Anthropic API (needs ANTHROPIC_API_KEY)
provider: { name: 'anthropic', apiKey: 'sk-ant-xxx', baseUrl: '...', timeoutMs: 180_000 }
```

Only `name` is required. `apiKey` falls back to env, `region` falls back to `AWS_REGION`.

### model

Required. Provider-prefixed model id. For bedrock: `amazon-bedrock/us.anthropic.claude-opus-4-7`. For anthropic: `anthropic/claude-opus-4-7` (prefix optional — bare `claude-opus-4-7` also works).

### fallbacks

Optional. Array of model ids tried in order when the primary fails (timeout / throttle). Same prefix convention.

```ts
fallbacks: [
  'amazon-bedrock/global.anthropic.claude-sonnet-4-6',
  'amazon-bedrock/us.anthropic.claude-opus-4-6-v1',
  'amazon-bedrock/global.anthropic.claude-haiku-4-5-20251001-v1:0',
]
```

A fallback hits when the per-attempt timeout is exceeded. A call only fails entirely if every chain entry fails.

### inference

Optional. Defaults: `maxTokens: 8192`, `temperature: undefined` (provider default, typically 1.0 for Claude).

### allowlist

Required. Feishu open_ids (or equivalent channel user ids) permitted to trigger `write` and `dangerous` tools. Non-allowlisted users still get conversation and `read` tools.

**Important**: Feishu assigns **per-app open_ids**. A user who is `ou_xxx` to one app is a different `ou_yyy` to another. Add all relevant ids if the same human uses multiple feishu bots backed by different apps.

### memory

Required. `dir` is an absolute path to a git repo (or future repo — on first run, CC can `git init` it via `memory_write`).

`gitPush: true` (default) makes `memory_write` run `git add && commit && push origin HEAD` after every write. Set `false` for offline or review workflows.

### feishu

Optional. If absent, the `feishu` CLI subcommand errors at startup. Put the bot's app credentials here. Prefer env for `appSecret`:

```ts
feishu: {
  appId: 'cli_xxxxxxxxxxxxxxxx',
  appSecret: process.env.POSTLINE_FEISHU_APP_SECRET ?? '',
}
```

`botOpenId` is auto-fetched via `/bot/v3/info` at startup if absent. Set it explicitly to skip the round-trip.

`requireMention: true` (default) means groups only react to `@bot` messages. DMs always trigger. Set `false` to treat every group message as bot-addressed (noisy, only for dev).

### tools.builtin

Required (can be empty). Array of built-in tool ids to load. Each id expands into one or more `Tool` instances — e.g. `fs` expands to `fs_read`, `fs_write`, `fs_edit`.

See [TOOLS.md](TOOLS.md) for the full list and what each does.

### tools.options

Optional. Per-tool configuration keyed by id. Example:

```ts
options: {
  bash: { timeoutMs: 30_000, maxOutputBytes: 32 * 1024 },
  fs: {
    readAllow: ['/home/me/projects', '/tmp'],
    writeAllow: ['/home/me/projects/sandbox'],
  },
  web_fetch: {
    maxBytes: 5 * 1024 * 1024,
    hostDeny: ['internal.mycorp.com'],  // in addition to built-in RFC1918/IMDS block
  },
  openclaw_bridge: {
    token: process.env.CC_OPENCLAW_TOKEN,
    url: 'ws://localhost:18789',
    defaultSessionId: 'cc-collab',
    bin: '/path/to/openclaw',
  },
}
```

Unspecified fields take tool-specific defaults documented in TOOLS.md.

### logging

Optional. `pino` level filter. `info` is the default. `debug` emits the full request/response inspection on every tool call (noisy). `trace` includes streaming chunks (very noisy).

Note: regardless of level, secret patterns (API keys, GH tokens, Feishu secrets, PEM blocks) are redacted in the output. If you need raw logs for debugging, run with `CC_LOG_LEVEL=trace` *and* pipe through your own redactor — but never commit such logs.

## Environment variables (legacy path)

When no config file exists, `loadPostlineConfig` reads these and constructs a config automatically. All optional:

| env | maps to |
|---|---|
| `CC_PRIMARY_MODEL` | `model` |
| `CC_FALLBACK_MODELS` | `fallbacks` (comma-separated) |
| `CC_ALLOWLIST_OPEN_IDS` | `allowlist.openIds` (comma-separated) |
| `CC_MEMORY_DIR` | `memory.dir` |
| `CC_FEISHU_APP_ID` | `feishu.appId` |
| `CC_FEISHU_APP_SECRET` | `feishu.appSecret` |
| `CC_FEISHU_BOT_OPEN_ID` | `feishu.botOpenId` |
| `CC_OPENCLAW_TOKEN` | enables `openclaw_bridge` tool |
| `CC_OPENCLAW_URL` | `tools.options.openclaw_bridge.url` |
| `CC_OPENCLAW_SESSION` | `tools.options.openclaw_bridge.defaultSessionId` |
| `CC_OPENCLAW_BIN` | `tools.options.openclaw_bridge.bin` |
| `CC_LOG_LEVEL` | `logging.level` |
| `AWS_REGION` | `provider.region` (when `provider.name: bedrock`) |

New deployments should use `postline.config.ts`. Env variables are the backwards-compat path for the author's Phase 1 EC2 install.

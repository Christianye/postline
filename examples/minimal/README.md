# example: minimal

The smallest config that produces a working feishu bot. Useful as a first run to verify your feishu app credentials + LLM provider are wired correctly.

## Setup

```bash
# From repo root
cp examples/minimal/postline.config.ts .

# Fill in your feishu app id in the copied file, then:
export ANTHROPIC_API_KEY=sk-ant-xxx          # or use { name: 'bedrock' }
export POSTLINE_FEISHU_APP_SECRET=xxx

pnpm install
pnpm -r build
pnpm --filter @postline/cli run start
```

## What it does

- Connects to feishu via long-connection
- Responds to DMs and `@bot` group messages
- Only two tools: `echo` (smoke-test) and `bash_read` (read-only shell)
- No allowlist → anyone in your feishu org can chat with the bot
- No memory persistence (`gitPush: false`, a fresh memory dir that's not a git repo)

## Next step

Once this works, graduate to the full example (`examples/full`) which enables file tools, github integration, feishu docs reading, and proper allowlist.

---
'@postline/cli': minor
'@postline/config': minor
---

feat(slack): `postline slack` bridge + extract shared IM bridge runner (PR-DB-7)

Slack is now reachable end-to-end, and the telegram/slack turn loops are
unified instead of duplicated.

- **`im-bridge.ts`** — extracted the channel-agnostic IM bridge runner
  (config + provider/memory/tools assembly, own doorbell server, routing.md
  loader, turn loop, dispatch handling, `/approve` fallback, shutdown) from
  cmd-telegram. Parameterised by an `IMChannel` (structural `send` /
  `sendText` / `editText` / `listen` / `health`) + a per-channel
  `wireApproval` hook (the one place telegram callback_query vs slack
  block_actions diverge). PR-DB-7.
- **`cmd-telegram.ts`** shrank from ~470 lines to wiring only; behaviour
  unchanged.
- **`cmd-slack.ts`** + `postline slack` subcommand — Block Kit approval +
  slack allowlist, ~80 lines of wiring over the shared runner.
- **Config** `slack?: { appToken?, botToken?, botUserId?, allowlist?,
  requireMention?, apiBase? }`. `CC_SLACK_APP_TOKEN` + `CC_SLACK_BOT_TOKEN`
  env load it with no config file (parallel to feishu/telegram); env wins.

**Feishu's card-approval path (cmd-feishu.ts) is deliberately untouched** —
its richer surface (cards, DM, streaming, design-review poller) stays
bespoke; only the two button-approval adapters share the runner. Zero
regression risk to the live feishu bridge.

712 tests pass.

---
'@postline/cli': minor
'@postline/config': minor
---

feat(telegram): `postline telegram` bridge — wire the Telegram adapter to the turn loop (PR-DB-6 part 2)

Completes PR-DB-6. The Telegram adapter (#52) is now reachable end-to-end:

- New `postline telegram` subcommand running an independent bridge daemon
  (own doorbell server + worker registry), mirroring `postline feishu`.
- `cmd-telegram.ts` duplicates the channel-agnostic turn loop against
  `TelegramChannel` (D1 hybrid; shared `StreamingChannel` extraction is the
  deferred PR-DB-7).
- Config: `telegram?: { botToken?, allowlist?, requireMention?, apiBase?,
  streamingDebounceMs? }`. `CC_TELEGRAM_BOT_TOKEN` env loads it with no
  config file (parallel to `CC_FEISHU_*`); env wins over inline token.
- Allowlist keys on numeric Telegram user ids (merged into the global
  allowlist). Inline-keyboard + `/approve <id>` approval both wired.
- Wake-prefix routing, responder attribution, and stream-json progress all
  carry over unchanged (the narrow-waist payoff).

Deferred vs feishu (documented in the design doc, not silently dropped):
live-typing streaming edits, photo→turn ingestion, the design-review push
poller. Run feishu and telegram as separate processes on distinct doorbell
ports if you want both.

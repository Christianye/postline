# @postline/adapters-telegram

## 0.6.0

### Minor Changes

- 82fd058: feat(telegram): @postline/adapters-telegram package — zero-dep Telegram Channel

  New channel adapter implementing the core `Channel` interface plus the
  extended turn-runner surface (the same shape FeishuChannel exposes):

  - `getUpdates` long-poll loop with `update_id` offset acking + 429
    `retry_after` honouring + exponential backoff (`poll.ts`).
  - `Update` → `InboundMessage` parsing with group mention gating
    (`@botusername` / `/command`); private chats always pass (`parse.ts`).
  - `splitForTelegram` (4096-char hard limit, 4000 soft) (`split.ts`).
  - Inline-keyboard approval: `<verb>:<actionId>` callback_data, toast via
    `answerCallbackQuery`, resolve-in-place via `editMessageText`; mirrors the
    feishu 8-char actionId + TTL + `/approve <id>` fallback semantics
    (`approval.ts`).
  - In-place edits (`editText`), seed-message capture (`sendText`), photo
    download (`getFile` → file link).

  Zero-dependency: the Bot API subset we need is ~6 plain HTTPS+JSON calls, so
  no SDK (matches the roadmap "a Node process, local files… that is the whole
  stack" non-goal). Long-poll only, no inbound port — same posture as the
  feishu WS adapter. Bot-token-only auth (no TDLib).

  This is the adapter unit of PR-DB-6; the `postline telegram` CLI wiring lands
  in a follow-on. Design: `docs/designs/telegram-adapter.md`.

### Patch Changes

- Updated dependencies [d8791cb]
- Updated dependencies [5040a61]
  - @postline/core@0.6.0

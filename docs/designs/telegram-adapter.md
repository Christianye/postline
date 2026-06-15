# Telegram adapter (PR-DB-6) · design plan

> Status: **SHIPPED · 2026-06-15** · Author: mac CC · Sole owner: mac CC
> Part 1 (adapter package, #52) + Part 2 (`postline telegram` CLI wiring) both landed. D1 hybrid: cmd-telegram.ts duplicates the cmd-feishu turn loop against TelegramChannel; StreamingChannel extraction (PR-DB-7) deferred. Deferred vs feishu (documented, not dropped): live-typing streaming edits, photo→turn ingestion, design-review push poller — follow-ons.
> Lifecycle: design → operator review on D1-D5 → freeze → impl
> Source: `docs/designs/postline-reframe.md` §3.3 (PR-DB-6) + RFOQ4 (bot-token-only, locked).
> Delivers the second IM in the reframe promise: "Feishu / Lark / **Telegram**".

---

## 1 · Goal

A `@postline/adapters-telegram` package that lets postline bind a Telegram bot
and route messages to CC workers, with the same UX the Feishu adapter ships:
streamed in-place progress edits + in-chat approval for dangerous tools.

Acceptance: `postline telegram` (new subcommand) connects a bot via token,
`!pl@<repo>` from a Telegram chat dispatches to a worker, progress streams back
by editing one message in place, dangerous tools surface an inline-keyboard
approval prompt.

---

## 2 · The actual problem (not what it looks like)

Implementing the core `Channel` interface is trivial — it's 4 methods:

```ts
interface Channel {
  name: string;
  listen(onMessage): () => Promise<void>;
  send(msg): Promise<void>;
  health(): Promise<{ ok: boolean; detail?: string }>;
}
```

**But the CLI turn-runner doesn't consume `Channel`.** `packages/cli/src/cmd-feishu.ts`
(842 lines) is typed against the *extended* `FeishuChannel`, and uses its
Feishu-specific methods throughout:

| Method | Call sites | Used for |
|---|---|---|
| `channel.send` | 19 | base — chunked replies |
| `channel.editText` | 2 | **streaming**: edit one message in place as the worker emits progress |
| `channel.sendText` | 1 | capture the seed message_id to edit |
| `channel.sendApprovalCard` | 1 | dangerous-tool approval card |
| `channel.onCardAction` | 1 | receive approve/deny button clicks |
| `channel.downloadImage` | 1 | vision input |

There is **no channel registry** (unlike the provider registry). `bin.ts`
hardcodes a `feishu` subcommand that calls `createFeishuChannel` directly.

So a Telegram adapter that only implements base `Channel` would get plain
request/reply and **lose streaming + approval + vision** — the whole UX. To
keep parity, Telegram must either (a) duplicate the 842-line turn-runner, or
(b) we extract a channel-agnostic turn-runner first.

This is the central decision (D1 below).

---

## 3 · Telegram API maps cleanly to the extended surface

Good news: every FeishuChannel capability has a direct Telegram Bot API analog,
and several are *simpler* on Telegram.

| FeishuChannel capability | Telegram Bot API | Notes |
|---|---|---|
| `listen` (Lark WSClient long-poll) | `getUpdates` long-polling | **No inbound port** — matches reframe's "no public webhook" stance exactly. Webhook mode exists but we don't use it (same reason feishu uses ws). |
| `send` (chunked, 4500-char) | `sendMessage` | Telegram limit is 4096 chars; need a `splitForTelegram`. |
| `editText` (streaming edits) | `editMessageText` | **Cleaner than Feishu** — first-class, returns the message, no card API split. Rate limit ~1 edit/sec per chat → reuse the existing streaming debounce. |
| `sendText` → seed message_id | `sendMessage` returns `message_id` | Direct. |
| `sendApprovalCard` + `onCardAction` | `sendMessage` + `reply_markup.inline_keyboard` + `callback_query` updates | Buttons carry `callback_data` (≤64 bytes — fits our 8-char action_id + verb). `answerCallbackQuery` for the toast. Inline replacement via `editMessageReplyMarkup` / `editMessageText`. |
| `downloadImage` | `getFile` → `file_path` → download | Photos arrive as `message.photo[]` (size variants); pick largest. |
| @-mention gating (`requireMention`) | `message.entities[].type === 'mention'` or `bot_command` | Group chats: gate on `@botusername` mention or `/` command; 1:1 always passes. Same shape as feishu's `mentionedOpenIds`. |
| open_id allowlist | `from.id` (numeric) / `from.username` | Allowlist keys on Telegram user id. Config gains a telegram allowlist field. |
| event dedup (across reconnects) | `update_id` monotonic | Even simpler than feishu — `update_id` is a strict offset; persist last-seen, never reprocess. |

No capability is missing. Telegram's auth is **bot token only** (RFOQ4 locked) —
no TDLib, no user-account login.

---

## 4 · Decisions for the operator (D1-D5)

### D1 · Refactor-first vs duplicate-first  ⭐ the big one

The turn-runner coupling (§2) forces a choice:

- **Option A — duplicate-first**: ship `cmd-telegram.ts` as a near-copy of
  `cmd-feishu.ts`, typed against a new `TelegramChannel`. Fast to ship; ~800
  lines of duplicated turn logic; two runners drift over time. Telegram works
  end-to-end in ~1 PR.
- **Option B — refactor-first**: extract the channel-agnostic turn-runner into
  `packages/core` behind a `StreamingChannel` interface (the union of methods
  cmd-feishu actually needs: `send`/`sendText`/`editText`/`sendApproval`/
  `onApprovalAction`/`downloadImage`). Feishu + Telegram both implement it.
  cmd-feishu shrinks to wiring. Bigger blast radius (touches the shipped feishu
  path → regression risk on the live bot), but no duplication and the *next*
  adapter (Lark/Slack) is then nearly free.
- **Option C — hybrid (my lean)**: ship Telegram duplicate-first (Option A) as
  PR-DB-6, **then** schedule the extraction (Option B) as a separate PR-DB-7
  once two concrete adapters exist to extract *from* — you refactor against
  reality, not a guessed abstraction. Avoids destabilising the live feishu bot
  under deadline; pays the dedup debt deliberately, not by accident.

My recommendation: **C (hybrid)**. Rationale matches `feedback_equivalence_tests_before_migration` instinct — don't abstract before you have two real implementations; and don't refactor the live-on-EC2 feishu path while also introducing a new adapter in the same PR.

### D2 · Approval UX shape on Telegram

Inline keyboard with two buttons (Approve / Deny), `callback_data =
"<verb>:<actionId>"`. On click: `answerCallbackQuery` toast + `editMessageText`
to the resolved state (mirrors feishu's `buildResolvedCard`). Text fallback
`/approve <id>` / `/deny <id>` stays (same as feishu). **Confirm**: keep the
exact same 8-char actionId + TTL auto-deny semantics? (Lean: yes, identical.)

### D3 · Streaming debounce

Telegram rate-limits edits to ~1/sec per chat (looser than feishu's 5 req/s but
edits specifically are throttled). Reuse the existing `streamingDebounceMs`
config knob; default may need to bump to ~1000ms for Telegram vs feishu's 250ms.
**Confirm**: per-channel debounce default, or one shared knob? (Lean: per-channel
default, shared override.)

### D4 · Config + allowlist surface

`postline.config.ts` gains an optional `telegram?: { botToken, allowlist?:
(number|string)[], requireMention?, streamingDebounceMs? }` block, sibling to
`feishu?`. Bot token via env (`CC_TELEGRAM_BOT_TOKEN`) per SSM/secret hygiene —
never inline. **Confirm**: same `allowlist` semantics (empty = nobody can
trigger dangerous tools)?

### D5 · Dependency choice

Telegram Bot API client: `node-telegram-bot-api` (mature, long-polling built-in)
vs `grammy` (modern, typed, smaller) vs **zero-dep** (the Bot API is plain
HTTPS + JSON; `getUpdates`/`sendMessage`/`editMessageText` are ~6 fetch calls).
**Lean: zero-dep** — matches the roadmap non-goal "Redis / Kafka / any extra
infra… a Node process, local files… that is the whole stack", keeps the
supply-chain surface minimal, and the API subset we need is tiny. Feishu needs
the SDK for ws; Telegram doesn't.

---

## 5 · PR breakdown (under D1=Option C)

```
PR-DB-6 · telegram adapter (duplicate-first)
  ├── @postline/adapters-telegram package
  │     ├── index.ts        createTelegramChannel() — TelegramChannel iface
  │     ├── poll.ts         getUpdates long-poll loop + update_id offset
  │     ├── parse.ts        Update → InboundMessage (text/photo/mention gating)
  │     ├── split.ts        splitForTelegram (4096-char)
  │     ├── approval.ts     inline keyboard build + callback_query parse
  │     └── *.test.ts       parse / split / dedup / approval (mirror feishu tests)
  ├── packages/cli/src/cmd-telegram.ts   turn-runner (initial near-copy of cmd-feishu)
  ├── bin.ts                 add 'telegram' subcommand
  ├── packages/config/src/types.ts   telegram config block
  ├── docs/                  cookbook + config + README "Quick start (Telegram)"
  └── changeset (minor)

PR-DB-7 · extract channel-agnostic turn-runner (deferred, post-6)
  └── StreamingChannel interface in core; cmd-feishu + cmd-telegram both wire to it.
      Equivalence: feishu behaviour byte-identical before/after (per feedback_equivalence_tests).
```

---

## 6 · Risks

| Risk | Mitigation |
|---|---|
| Duplicate turn-runner drifts from feishu | D1=C makes it explicit + schedules PR-DB-7; not silent debt |
| Telegram edit rate-limit (429) mid-stream | reuse streaming debounce (D3); on 429 honour `retry_after`, fall back to fewer edits |
| `callback_data` 64-byte cap | our payload is `<verb>:<8char>` ≈ 16 bytes — comfortable |
| Polling offset lost on restart → reprocess | persist last `update_id` (like feishu ws-state tick); on boot, ack with `offset` to skip backlog |
| Live feishu regression | D1=C keeps PR-DB-6 from touching cmd-feishu at all |
| `splitForTelegram` markdown breakage (Telegram MarkdownV2 is strict) | default to plain text (no parse_mode) for v1, like feishu's text msg_type; rich formatting deferred |

---

## 7 · Out of scope (v1)

- TDLib / user-account login (RFOQ4 locked: bot-token only)
- Telegram webhook transport (long-poll only, matches feishu + reframe no-port stance)
- MarkdownV2 / HTML rich formatting (plain text v1)
- Inline mode / slash-command menus beyond `/approve`-style fallbacks
- Group admin / multi-bot orchestration

---

## 8 · Self-review checklist (mac CC, pre-freeze)

- [ ] D1 framing fair? Is hybrid actually lower-risk than refactor-first, or am I deferring necessary work?
- [ ] Does zero-dep (D5) underestimate Telegram API edge cases (file download, 429 backoff, update types)?
- [ ] Is `StreamingChannel` (D1 Option B/C) the right extracted interface, or will Lark/Slack need a different cut?
- [ ] Allowlist on numeric `from.id` — does Telegram id ever rotate / is username safer? (id is stable; username is mutable — key on id.)
- [ ] PR-DB-6 sized as one PR realistic, or split package vs cmd-telegram?

## Changelog

- **v1 · 2026-06-13 · mac CC**: initial draft. Maps FeishuChannel surface → Telegram Bot API (all capabilities covered). Central decision D1 (refactor vs duplicate); lean = hybrid (ship duplicate, schedule extraction PR-DB-7). Bot-token-only + long-poll + zero-dep leans. Awaiting the operator D1-D5.

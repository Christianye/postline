---
'@postline/doorbell': minor
'@postline/adapters-cli': patch
---

feat(onboarding): 5-minute getting-started — doctor dispatch check, /health, QUICKSTART, channel-aware init

Closes the gap between "v0.6.0 ships" and "a new user can actually run it"
(story chapter 5). Four pieces:

- **`postline doctor` now self-checks the dispatch path.** A new `doorbell`
  check signs a `GET /health` and reports: no doorbell configured → ok
  (embedded-only is valid); reachable + N workers → ok; reachable + 0 workers
  → warn ("run `cc-worker start`"); unreachable → warn (fail under
  `--strict`). Previously doctor could pass while dispatch was completely
  dead.
- **New doorbell `GET /health` endpoint** — HMAC-authed, read-only, returns
  `{ ok, workers }` (registered-worker count). Powers the doctor probe.
- **`docs/QUICKSTART.md`** — one-page Telegram-first walkthrough of the whole
  `init → bridge → cc-worker → !pl@<repo>` loop, plus a worker-env-var table
  and a one-line-swap table for Slack/Feishu. README's quickstart links to it.
- **`postline init --channel <telegram|slack|feishu>`** — the printed
  next-steps are now channel-aware and reframe-correct (the right token env,
  bridge command, worker registration, and `doctor` verification), replacing
  the stale feishu-only "pnpm start" hint. Stays a pure scaffold — no
  interactive-prompt dependency.
- **`postline.config.example.ts`** gains commented `telegram` / `slack` /
  `doorbell` / `embeddedLlm` blocks (only `feishu` had one before).

+6 tests (/health endpoint, doctor doorbell check: disabled/no-worker/
ok/unreachable). Live-verified against a running bridge: `doctor` →
`doorbell up … 1 worker(s) registered`.

---
'@postline/tools-builtin': patch
'@postline/adapters-cli': patch
'@postline/cli': patch
---

fix(security): gate dispatch on the allowlist + close gh_query/web_fetch holes

Access-control gaps from the audit:

- **Worker dispatch was not allowlist-gated.** `handleRouteDecision`'s
  `dispatch_to_mac` branch enqueued a task for a full-privilege worker
  without checking `inbound.userId`, so any user who could DM/@-mention the
  bot could `!pl@<repo> <anything>` and run it. Both bridges (im-bridge for
  telegram/slack, cmd-feishu) now gate the dispatch branch on the allowlist.
  The embedded-LLM path keeps its existing read-only degradation for
  non-allowlist users; only dispatch is hard-blocked.
- **Feishu `/approve` slash skipped the base allowlist.** The card-click
  path gated on the allowlist, but the slash path relied only on the
  per-action authorizer — so with `requesterOnly=false` any user who could
  reach the bot could `/approve <id>` a pending dangerous tool. Now gated.
- **`gh_query` (read tier) allowed write API calls.** The guard was
  `/^api\s+(?!-X)/`, so `gh api --method DELETE …` and `gh api … -f field=x`
  (the `-f`/`-F`/`--field`/`--raw-field`/`--input` flags make `gh` default
  to POST) passed unapproved. Now only GET / no-method-no-field `api` calls
  are read-only.
- **`web_fetch` followed redirects without re-validating the host (SSRF).**
  `redirect:'follow'` + a one-time `isBlocked` check on the initial URL let
  a public URL 30x to `169.254.169.254` (IMDS) or `127.0.0.1` (the
  doorbell). Now follows redirects manually, re-validating every hop's host
  + protocol, capped at 5.

Note (backlog): telegram/slack approval still lacks `requesterOnly` (any
allowlisted user can approve another's tool); they DO gate the base
allowlist. Tracked separately.

+21 tests (gh api gate, web_fetch redirect re-validation).

---
'@postline/doorbell': minor
'@postline/adapters-cli': minor
---

feat(observability): `cc-worker watch` — local-terminal live view (PR-OBS-2)

See what every in-flight task is doing from any terminal (iTerm2 / Wave /
tmux), not just in the IM. Complements the in-IM progress feed (PR-OBS-1)
with the same events rendered locally.

- New doorbell `GET /watch` SSE endpoint (HMAC-authed like every endpoint,
  read-only). Sends an in-flight `snapshot` on connect, then live
  `progress` / `terminal` / `worker` events. Fan-out of what the
  coordinator already sees — no new state store [OQ-B1/B2/B3 = SSE /
  live+snapshot / same secret].
- `WatchEvent` / `WatchTask` types + `coordinator.subscribeWatch()` +
  `snapshotInFlight()`; events emit from register / progress / terminal /
  worker-removed.
- `postline cc-worker watch` subcommand: redrawing TUI (default) or
  `--plain` (append-only). Zero deps — plain ANSI, no ink/blessed.
- Also fixes a latent bug: the register handler dropped `agentKind` from
  the worker registration (added in the wake-prefix PR but never forwarded
  server-side), so responder attribution + the watch view now show the
  real agent kind.

Design: `docs/designs/observability.md` §3 (now SHIPPED).

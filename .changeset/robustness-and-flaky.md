---
'@postline/adapters-telegram': patch
'@postline/adapters-slack': patch
---

fix: surface swallowed handler errors + de-flake runtime-state suffix

Three small robustness fixes from the v0.6.0 review:

- **telegram poll loop** — a throwing `onUpdate` handler was caught and
  silently discarded. It still must not stall the loop or lose the offset,
  but the error is now routed to `onError` instead of vanishing.
- **slack socket loop** — `onEnvelope` was fired as `void
  opts.onEnvelope(env)`; a rejected async handler became an unhandled
  rejection. Now routed to `onError` via `.catch` (still fire-and-forget —
  the envelope is already acked).
- **runtime-state** — `buildRuntimeStateSuffix` now takes an injectable
  `now`. The real caller still captures it once at startup; tests inject a
  fixed time. This removes a flaky test: `readGitHead()` spawns git between
  two back-to-back builds, which under load could straddle a one-second
  boundary and change the seconds-granularity `started_at`.

(The runtime-state fix lives in `@postline/cli`, which is in changeset
`ignore` — it ships with the repo, so it's not listed in the frontmatter.)

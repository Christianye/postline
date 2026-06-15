---
'@postline/doorbell': minor
'@postline/adapters-cli': patch
---

feat(router): selector routing — `!pl@<selector>@<repo>` dispatches by agentKind/host (PR-AGENT-2)

The 3-segment wake-prefix selector is now functional. A cc worker and a
codex worker can register for the same repo concurrently, and
`!pl@cc@repo` vs `!pl@codex@repo` reach the right one.

- Registry slots are now keyed by `(cwd, agentKind)` instead of `cwd`, so
  workers of different kinds for one repo are both active (no mutual
  demotion). `activeForCwd(cwd, selector?)` matches a worker's `agentKind`
  OR `hostname`.
- `enqueueAndMaybeDispatch({…, selector})` dispatches to the matched
  worker; both IM bridges (feishu + telegram/slack) thread the parsed
  `decision.selector` through (was advisory-log-only).
- **Back-compat preserved**: no selector + a single worker kind resolves
  exactly as before; same-`(cwd,agentKind)` still latest-wins + standby
  promote. All 81 prior doorbell tests unchanged; +5 slot/selector tests.

Completes the codex-worker design (`docs/designs/codex-worker.md` §3,
registry Option A).

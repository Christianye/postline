---
'@postline/doorbell': minor
'@postline/adapters-cli': minor
---

feat(keeper): auto-default-worker C2 — `cc-worker keeper` auto-starts a worker on wake

Completes the auto-default-worker RFC (Model C). When a task is queued for
a repo with no active worker, the doorbell now emits a **`wake`** watch
event; a per-host `cc-worker keeper` acts on it by starting a worker.

- New `wake` `WatchEvent` (`{cwd, selector?, taskId}`), emitted from
  `enqueueAndMaybeDispatch` only when there's no active worker for the cwd.
  Pure signal — **the bridge never spawns** (RF2 intact).
- `postline cc-worker keeper --repo <abs-cwd>…` (or `CC_KEEPER_REPOS`):
  subscribes to `GET /watch`, and on a wake for a repo on its allowlist,
  spawns `cc-worker start` (`--agent codex` if the wake selector is codex).
- Two security gates (RFW4): the bridge only emits wake for allowlisted
  senders; the keeper only starts workers for repos on its **own** list,
  never an arbitrary cwd from the wire. Idempotent — a wake for a cwd with
  a keeper-spawned worker still running is ignored.

End-to-end: `!pl@<repo>` to a repo with no worker → queued + held (C1) →
keeper starts a worker → held task drains. No manual `cc-worker start`.

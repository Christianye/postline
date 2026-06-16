---
'@postline/doorbell': patch
---

fix(doorbell): don't reap a worker busy with a long task (double-dispatch bug)

Dogfood-caught 2026-06-16: a worker running a task longer than the
heartbeat stale threshold (60s) doesn't poll while `runTask` blocks, so the
sweep reaped it mid-run and **re-dispatched its in-flight task to another
worker** for the same cwd. Surfaced when a slow `codex exec` task got
double-run by the cc worker that shared the repo.

Two layers, both added:
- **Sweep exemption** (safety net): `sweepStale` skips workers that own a
  `dispatched`/`running` task (`queue.busyWorkerIds()`). A busy worker
  isn't polling but isn't dead.
- **Progress = heartbeat** (active signal): `/mac/progress` now
  `touchPolled`s the reporting worker — a progress post proves liveness, so
  a task that emits progress keeps its worker fresh.

Idle stale workers are still reaped (test split into busy-exempt vs
idle-reaped). No worker-side change needed.

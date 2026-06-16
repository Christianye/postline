---
'@postline/adapters-cli': patch
---

feat(bridge): auto-default-worker C1 — queue-and-hold + actionable "start a worker" reply

Per the auto-default-worker RFC (Model C, ship C1): when a dispatch
resolves a repo but no worker is registered yet, the task is enqueued and
**held** (it already was — this surfaces it honestly) and the reply now
tells the operator exactly how to start a worker on the host with the repo,
instead of the scary "queued (lost if postline restarts)".

```
🟠 queued #a3f8 · no worker for `postline` yet — runs as soon as one registers.
Start one on that host: `cd /…/postline && cc-worker start` (or --agent codex).
```

- Selector-aware hint: `!pl@codex@repo` suggests `--agent codex`.
- The `reject_no_worker` path (keyword miss, no cwd resolved) now points at
  the explicit `!pl@<repo>` form rather than a generic "start a worker".
- **No bridge spawn** — RF2 intact. The keeper that auto-starts a worker
  (C2) is the deferred follow-on; design in `docs/designs/auto-default-worker.md`.

UX-only; the queue-hold behaviour is unchanged (tasks already drained on
worker registration). 719 tests pass.

# @postline/doorbell

## 0.5.0

### Minor Changes

- b572ad1: feat(doorbell): PR-DB-1 — endpoints + queue + worker registry + HMAC + long-poll

  First substantive piece of the Doorbell sprint (`docs/SPRINT_PLAN_DOORBELL.md`).
  Adds a new `@postline/doorbell` package with the HTTP surface CC workers
  (cc-worker skill, lands in PR-DB-3) register against, plus the cli
  wiring to spawn the server on `runFeishu` start-up.

  What ships:

  - Protocol types (Worker, Task, TaskStatus, QueueFullError, DemotedError)
    matching `docs/designs/doorbell.md` v3.
  - HMAC sign/verify (sha256 over method+path+body+ts; 60s default skew
    window; constant-time compare). Tagged failure reasons map to 400 /
    401 / 403 wire status.
  - WorkerRegistry: per-cwd FIFO standby with latest-wins on registration.
    Hooks for onDemoted / onPromoted / onRemoved. `sweepStale(now,
thresholdMs)` returns the swept workers.
  - TaskQueue: per-cwd FIFO with hard cap (default 10). 11th request gets
    the structured QueueFullError shape; rejection does NOT consume a
    slot. Tasks bind to an owning workerId at dispatch (M3 lock) and
    stay bound through demotion. `releaseWorker(id)` reverts in-flight
    tasks to head-of-queue with retryCount++.
  - DoorbellCoordinator: ties registry × queue. Owns the heartbeat sweep
    timer (default 60s/60s). `enqueueAndMaybeDispatch` wakes parked
    long-polls. `subscribePoll` lets the HTTP server park a request and
    cancel on hangup. Demotion → 409. Promotion drains queue immediately.
  - DoorbellServer (HTTP, binds 127.0.0.1:9999 by default per §6.1).
    Endpoints: POST /mac/register, GET /mac/poll, POST /mac/progress,
    POST /mac/result. Long-poll holds up to 30s with wake on enqueue
    (200), demote (409), removal (401), or timeout (204). Audit-log every
    register / auth_rejected as structured pino. First-hostname-seen hook
    fires once per hostname per server lifetime.
  - @postline/config: new `doorbell` block (toggle / host / port / secret
    / queueMax / longPollTimeoutMs / hmacWindowMs / sweepIntervalMs /
    staleThresholdMs / auditFeishuReceiverOpenId).
  - @postline/adapters-feishu: new `FeishuChannel.sendDirectMessage` (DM
    by open_id) — used by the audit Feishu DM path.
  - @postline/cli: `runFeishu` now starts the doorbell server when the
    config block is enabled, and tears it down on SIGINT/SIGTERM.

  What's NOT in this PR (deliberately, comes later):

  - Router that decides which messages dispatch to the doorbell — that's
    PR-DB-2.
  - The `cc-worker` skill that registers against these endpoints — PR-DB-3.
  - ETA + progress UX + status query in Feishu — PR-DB-4.

  69 new tests in @postline/doorbell. Workspace 570/0 green.

- aa2be15: feat(doorbell): PR-DB-4 — ETA validation + Feishu progress edits + status / workers

  Closes the IM UX gap left by PR-DB-1..3:

  - Server-side ETA validation: numeric, > 0, ≤ 3600s. Otherwise dropped
    silently. Per design F14.
  - Coordinator hooks `onTaskProgress` / `onTaskTerminal` fire on
    /mac/progress and /mac/result respectively. cmd-feishu subscribes
    these and uses `channel.editText(seedMessageId, …)` to mutate the
    same Feishu message that announced the dispatch.
  - Progress edits debounced 5s per task per Feishu rate-limit guard.
  - Terminal edit: 🟢 #id done + body / 🔴 #id timeout / 🔴 #id failed
    - errorMessage. 4500-char clip at end.
  - Seed-message capture: dispatch path now uses `channel.sendText`
    (which returns msgId) instead of `channel.send`, then stashes the
    msgId on the task so the hooks can find it.
  - New builtin queries handled by the bridge before the router runs:
    - `@cc workers` → registry snapshot, per-cwd active + standby
      listing with last-poll age.
    - `@cc status #a3f8` → recorded task state (status / cwd / owner /
      retries / timestamps / feishu msg id).

  Tests: 8 new in @postline/doorbell `progress.test.ts` covering ETA
  validation (>3600 / ≤0 / non-numeric / valid), terminal status mapping
  (ok→done / failed / timeout), hook-error tolerance. Workspace 641 / 0.

  The IM round-trip from PR-DB-3 now arrives back as live, edited
  progress instead of just a one-shot 🟡 line. Tasks that take >5s
  update the user as they go; the final result replaces the seed.

### Patch Changes

- Updated dependencies [1c3efa3]
- Updated dependencies [d92d505]
  - @postline/core@0.5.0

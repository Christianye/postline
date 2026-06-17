# @postline/doorbell

## 0.6.0

### Minor Changes

- 98ac88f: feat(keeper): auto-default-worker C2 — `cc-worker keeper` auto-starts a worker on wake

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

- 1ce3b80: feat(observability): `cc-worker watch` — local-terminal live view (PR-OBS-2)

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

- 29f4633: feat(observability): live structured progress from stream-json (PR-OBS-1)

  The cc-worker now spawns headless Claude with `--output-format stream-json
--verbose` and parses the event stream, so the IM reply shows a live activity
  feed instead of a tail-of-stdout snapshot:

  ```
  🟡 cc@postline · mac · #a3f8 running · ETA ~25s
  🔧 Bash: git show --stat
  🔧 Read: matcher.ts
  The diff looks fine.
  🟢 cc@postline · mac · #a3f8 done
  ```

  - New `ProgressEvent { kind: 'init'|'tool'|'thinking'|'text', label }` on the
    progress protocol (doorbell types + `/mac/progress`), validated at the trust
    boundary. Free-text `summary` stays as the fallback for agents without a
    structured stream (e.g. a future codex-worker).
  - Final result text now comes from the authoritative `result` event.
  - `💭 thinking` is off by default (elided single line when
    `CC_WORKER_SHOW_THINKING=1`).
  - Tool boundaries flush an eager progress edit; the bridge keeps a rolling
    activity log per task.

  This is the narrow-waist progress format that telegram / slack adapters and the
  upcoming `cc-worker watch` TUI all render — build once, every IM × agent
  inherits it. See `docs/designs/observability.md`.

- 701faf0: feat(router): selector routing — `!pl@<selector>@<repo>` dispatches by agentKind/host (PR-AGENT-2)

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

- d8791cb: feat(router): configurable wake-prefix + agent-kind selector + responder attribution

  **BREAKING**: the override-prefix grammar changed (no back-compat).

  - `!cc` / `!cc:repo` / `!cc:repo@host` → `!pl` / `!pl@repo` / `!pl@selector@repo`
  - `!ec2` / `!plain` → `!pl ec2` / `!pl plain` (sub-keyword form)
  - Wake-name `pl` is configurable via a `## wake` section in `routing.md` (default `pl`; reserved words `ec2`/`plain` rejected).
  - 3-segment middle slot is a **selector** matching a worker's `host` OR `agentKind` (cc / codex / …). Workers now report `agentKind` on registration (`cc-worker` sends `cc`); optional for back-compat.
  - Every worker reply carries a **responder-attribution header**: `🤖 <agentKind>@<repo> · <host>`.

  v1 note: the selector is parsed, carried, logged, and used for attribution, but dispatch remains cwd-keyed (one active worker per cwd). Selector-aware worker selection and auto-default-worker are tracked as follow-on designs.

### Patch Changes

- d1e0956: fix(doorbell): don't reap a worker busy with a long task (double-dispatch bug)

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

- Updated dependencies [d8791cb]
- Updated dependencies [5040a61]
  - @postline/core@0.6.0

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

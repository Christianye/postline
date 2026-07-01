# @postline/adapters-cli

## 0.7.0

### Minor Changes

- feat(onboarding): channel-aware `init` + doctor dispatch check + QUICKSTART wiring (#77)
- feat(onboarding): `routing.md` starter drop + docker worker docs + first-message self-intro via `onboardingHint()` (#78)
- fix: selector-aware dispatch + per-`(cwd,kind)` keeper (#73)
- fix(security): allowlist-gate dispatch + Feishu `/approve` base-allowlist (#71)
- fix(security): redact worker→bridge→IM path (#70)

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

- fecca35: feat(cc-worker): codex agent kind — `cc-worker start --agent codex` (PR-AGENT-1)

  A worker can now back its dispatched tasks with **Codex** instead of Claude
  Code. `runTask` was refactored around an `AgentSpec` (bin + spawn args +
  per-line event parser); the shared scaffold (spawn, debounce, deadline,
  result assembly, POST) is identical across agents.

  - `--agent codex` (or `CC_WORKER_AGENT_KIND=codex`) spawns `codex exec
--json` (sandbox `workspace-write`) instead of `claude -p`.
  - Codex JSONL events map to the same progress protocol: `command_execution`
    → 🔧 tool, `agent_message` → text; final answer = the last
    `agent_message` (codex has no single result field). No bridge change —
    the `ProgressBody` shape is unchanged.
  - Worker reports `agentKind: codex` on registration (already plumbed for
    responder attribution + the watch view).

  Selector routing (`!pl@codex@repo` reaching a codex worker on a repo that
  also has a cc worker) is the follow-on PR-AGENT-2. A codex worker is useful
  now for any repo where it's the only registered worker.

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

- c2014b7: feat(deploy): resident LaunchAgents (config-driven bridges + keeper) + keeper hardening

  Resident-deployment story (docs/designs/resident-deploy.md, Layer A) — keep
  the IM bridges + the auto-worker keeper alive across reboots, config-driven.

  deploy/launchd/ (new, generic templates for the public repo):

  - postline-bridge.plist.template / postline-keeper.plist.template
    (KeepAlive + RunAtLoad LaunchAgents).
  - install-resident.sh — reads a resident config (RESIDENT_CHANNELS,
    KEEPER_REPOS, …), renders launcher scripts + plists, loads them.
  - resident.conf.example.

  Keeper hardening — five bugs caught dogfooding the resident keeper (all
  "ships fine, only breaks when actually long-running"):

  - SSE `/watch` long-poll gets `terminated` / the bridge may be down at boot
    → wrap in a reconnect loop with backoff (was: keeper exited → launchd
    thrash-restart).
  - worker spawn `error` (ENOENT) was unhandled → killed the keeper → add
    `child.on('error')` that drops the slot + keeps running.
  - spawned `postline` not on PATH → keeper now spawns `process.execPath`
    (node) + the running bin.js via the new `cliPrefixArgs` option.
  - (deploy) launcher PATH must include `~/.local/bin` (claude) and set
    `CLAUDE_CODE_USE_BEDROCK` — documented; the worker inherits them from the
    sourced env file.

  End-to-end verified live: telegram `!pl@<repo>` with no worker → bridge
  wake → resident keeper auto-starts a worker → task drains → done, fully
  hands-off. 725 tests (keeper +7: reconnect, spawn-failure survival).

- d8791cb: feat(router): configurable wake-prefix + agent-kind selector + responder attribution

  **BREAKING**: the override-prefix grammar changed (no back-compat).

  - `!cc` / `!cc:repo` / `!cc:repo@host` → `!pl` / `!pl@repo` / `!pl@selector@repo`
  - `!ec2` / `!plain` → `!pl ec2` / `!pl plain` (sub-keyword form)
  - Wake-name `pl` is configurable via a `## wake` section in `routing.md` (default `pl`; reserved words `ec2`/`plain` rejected).
  - 3-segment middle slot is a **selector** matching a worker's `host` OR `agentKind` (cc / codex / …). Workers now report `agentKind` on registration (`cc-worker` sends `cc`); optional for back-compat.
  - Every worker reply carries a **responder-attribution header**: `🤖 <agentKind>@<repo> · <host>`.

  v1 note: the selector is parsed, carried, logged, and used for attribution, but dispatch remains cwd-keyed (one active worker per cwd). Selector-aware worker selection and auto-default-worker are tracked as follow-on designs.

### Patch Changes

- f0cc094: feat(bridge): auto-default-worker C1 — queue-and-hold + actionable "start a worker" reply

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

- 3b89b61: fix(cc-worker): pin codex reasoning effort to `low` for headless runs

  A codex worker spawned `codex exec` with the operator's global
  `model_reasoning_effort` (often `high`/`xhigh` for interactive use). On
  short dispatched tasks that made codex deep-reason + autonomously read
  `~/.claude/skills/**/SKILL.md` before answering — measured ~31s + 23k input
  tokens for a one-word reply.

  The codex worker now passes `-c model_reasoning_effort=low` (override via
  `codexReasoningEffort`). Same one-word reply drops to ~4s, and codex stops
  the skill-discovery detour. Not a postline bug — codex's behaviour under
  high reasoning — but the headless worker shouldn't inherit interactive
  tuning.

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

- Updated dependencies [d8791cb]
- Updated dependencies [5040a61]
  - @postline/core@0.6.0

## 0.5.0

### Patch Changes

- Updated dependencies [1c3efa3]
- Updated dependencies [d92d505]
  - @postline/core@0.5.0

## 0.3.1

### Patch Changes

- Updated dependencies [299d3de]
  - @postline/core@0.4.0

## 0.2.1

### Patch Changes

- Updated dependencies [02aaa89]
- Updated dependencies [e8e1264]
  - @postline/core@0.3.0

## 0.1.11

### Patch Changes

- Updated dependencies [d7dadb1]
- Updated dependencies [377b80b]
  - @postline/core@0.2.0

## 0.1.10

### Patch Changes

- Two fixes shipped together as 0.1.10:

  - **Prevent orphan `tool_use` blocks from poisoning conversation history.** When a stream errored or hit `max_tokens` after the assistant emitted a `tool_use` block, the turn loop persisted the assistant message but no matching `tool_result`, so subsequent turns reloaded a malformed `messages[0]` and the Anthropic API rejected with `Expected toolResult blocks at messages.0.content for the following Ids`. `@postline/core` now injects a synthetic `isError` `tool_result` on abort, and `@postline/cli` adds a `sanitizeHistory` pass on `load()` that drops orphan rows already on disk so existing polluted jsonl files heal automatically. (#1)
  - **Inline-swap the approval card on click.** Clicking Approve or Deny on a dangerous-tool approval card now atomically replaces the card with a resolved-state variant (green ✅ "Approved" / grey ❌ "Denied", no buttons, signed by clicker + timestamp). `buildApprovalCard` now sets `config.update_multi: true` (required for inline replacement), `CardActionResponse` gains an optional `card?: { type: 'raw'; data }` field, `buildResolvedCard` is newly exported from `@postline/adapters-feishu`, and `PendingActions` gains a `get(id)` accessor so adapters can read entry metadata before resolving. (#2)

- Updated dependencies
  - @postline/core@0.1.10

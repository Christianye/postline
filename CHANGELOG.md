# Changelog

All notable changes to postline are recorded here. Format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow [SemVer](https://semver.org/).

Per-package changelogs live under `packages/*/CHANGELOG.md` once [changesets](https://github.com/changesets/changesets) starts writing to them. This top-level file tracks repo-wide releases.

## [0.7.0] — 2026-07-02

The **get-started + hardening** release. It closes the gap between "0.6.0 ships" and "a stranger can run it safely in five minutes": a self-checking `doctor`, a one-page quickstart, channel-aware `init`, and a first-message self-intro — plus the full security and robustness backlog from the post-0.6.0 health-check audit. Everything since 0.6.0 (#66–#78); all packages bumped 0.6.0 → 0.7.0 (lockstep).

### Added

- **5-minute getting-started.** `postline doctor` now self-checks the dispatch path — a new `doorbell` check signs a `GET /health` and reports no-doorbell → ok, reachable+N-workers → ok, reachable+0-workers → warn, unreachable → warn (fail under `--strict`); previously doctor could pass while dispatch was dead. New HMAC-authed, read-only doorbell `GET /health` endpoint returns `{ ok, workers }`. New `docs/QUICKSTART.md` walks the whole `init → bridge → cc-worker → !pl@<repo>` loop. `postline init` is now channel-aware. (#77)
- **`routing.md` starter + docker worker docs + first-message self-intro.** `docs/routing.example.md` (annotated, copy-paste) + `postline init` drops a minimal `routing.md` into the memory dir so a new user edits instead of stares at a blank file. `deploy/docker/README.md` gains a "Dispatching to a cc-worker" section. The `reject_no_worker` reply now reads as a one-line self-intro + dispatch shape via a shared `onboardingHint()`, so Feishu/Telegram/Slack greet identically. (#78)

### Security

- **`bash_read` sandbox bypasses closed.** The auto-approved `bash_read` tool no longer accepts command/process substitution (`$(…)`, backticks, `<(…)`/`>(…)`), `tee`/`bash`/`sh`, or state-mutating flags (`find -delete`/`-exec`, `sed -i`, `awk system()`/redirection) while keeping plain read-only forms. (#69)
- **Secret redaction on the worker→bridge→IM path.** The doorbell/worker path now redacts (previously raw tool output and final answers were POSTed and edited into the IM verbatim). Added key patterns: `sk-ant-…`, `sk-…`/`sk-proj-…`, Slack `xox*`/`xapp-`, fine-grained `github_pat_…`; AWS access-key id now case-insensitive; AWS secret-key matches the keyword-precedes-value form. (#70)
- **Dispatch gated on the allowlist.** `dispatch_to_mac` enqueued a full-privilege worker task without checking `inbound.userId` — any user who could DM/@-mention the bot could run arbitrary code. Both bridges now gate the dispatch branch on the allowlist; the embedded-LLM path keeps its read-only degradation. Also closed `gh_query`/`web_fetch` holes and a Feishu `/approve` slash path that skipped the base allowlist. (#71)
- **Audit backlog cleared.** Telegram/Slack approval now enforces the same requester-only rule as Feishu via a shared `authorizeApproval` (admin override, configurable); terminal task status is now absorbing (a late `running` post can no longer resurrect a `done`/`failed`/`timeout` task); plus body-cap, fs-realpath, and poll-cleanup fixes. (#76)

### Fixed

- **No content duplication on mid-stream provider fallback.** Both providers now share a `runModelChain` with at-most-once content semantics — a failure is retried on the next model only if it happened before the first content-bearing chunk; a mid-stream failure is terminal instead of re-emitting the whole response. (#72)
- **Selector-aware dispatch + retry cap + per-kind keeper + slack dedup.** A `!pl@codex@repo` task can no longer be grabbed by a polling cc worker on the same cwd (the pull/requeue paths now honour the selector); `retryCount` fails a task terminally after `MAX_RETRIES` instead of head-of-lining its queue forever; the keeper's "one worker per cwd" is now per `(cwd, kind)`; slack gained dedup + backoff. (#73)
- **Bounded task map.** `TaskQueue` now prunes terminal tasks after a retention window (`terminalRetentionMs`, default 60s) via `sweepTerminal`, so a long-running resident bridge no longer grows the source-of-truth map — and every O(n) scan over it — without bound. (#66)
- **Surfaced swallowed handler errors + de-flaked runtime-state.** A throwing Telegram `onUpdate` / rejected Slack `onEnvelope` handler is now routed to `onError` instead of vanishing; `buildRuntimeStateSuffix` takes an injectable `now`, removing a git-straddles-the-second flaky test. (#67)

### Docs

- Reconciled the docs with the shipped 0.6.0 state (audit docs batch). (#74)
- Neutralised two-instance actor identity in the design docs; scrubbed private-setup leaks from the public repo. (#68, #75)

[0.7.0]: https://github.com/Christianye/postline/releases/tag/v0.7.0

## [0.6.0] — 2026-06-17

The **IM × agent matrix** release. postline now bridges three IMs (Feishu/Lark, Telegram, Slack) to two agent kinds (Claude Code, Codex), with selector routing between them, an auto-worker keeper, and config-driven resident deployment. Everything since 0.5.0 (#50–#64); all packages bumped 0.5.0 → 0.6.0 (lockstep).

### Added

- **Telegram + Slack adapters.** New zero-dependency `@postline/adapters-telegram` (Bot API long-poll) and `@postline/adapters-slack` (Socket Mode) channels, plus `postline telegram` / `postline slack` bridge daemons. All three IM bridges share a channel-agnostic turn-runner (`im-bridge`), so behaviour (routing, approval, progress) is uniform; Feishu keeps its richer bespoke path. (#52, #53, #55, #56)
- **Codex agent kind.** `cc-worker start --agent codex` backs dispatched tasks with `codex exec` instead of `claude -p`. A cc worker and a codex worker can register for the same repo concurrently via `(cwd, agentKind)` registry slots. (#58)
- **Selector routing.** `!pl@<selector>@<repo>` dispatches to a worker by agent-kind or host — `!pl@codex@repo` vs `!pl@cc@repo` reach the right one. (#59)
- **Configurable wake-prefix + responder attribution.** The override grammar is now `!pl` / `!pl@<repo>` / `!pl@<selector>@<repo>`; the wake-name (`pl`) is configurable via a `## wake` section in `routing.md`. Every worker reply carries a `🤖 <agentKind>@<repo> · <host>` attribution header. (#50)
- **Live structured progress + `cc-worker watch`.** The worker spawns the agent with a structured event stream and surfaces a live activity feed (🔧 tool / 💭 thinking / text) into the IM message; `cc-worker watch` shows the same feed in any terminal via a read-only `GET /watch` SSE endpoint. (#51, #54)
- **Auto-default-worker.** When a dispatch resolves a repo with no worker, the task is queued-and-held with an actionable "start a worker" reply (C1); an opt-in per-host `cc-worker keeper` watches for the resulting `wake` intent and auto-starts a worker (C2). The bridge never spawns. (#60, #61)
- **Resident deployment.** `deploy/launchd/` templates + `install-resident.sh` keep the IM bridges + keeper alive across reboots, driven by a per-host config. (#64)

### Changed

- **BREAKING — wake-prefix grammar.** The old `!cc:repo@host` / `!ec2` / `!plain` prefixes are removed in favour of `!pl@<selector>@<repo>` and the `!pl ec2` / `!pl plain` sub-keyword forms. (#50)

### Fixed

- `routing.md` now accepts the documented `## worker_aliases` section name (previously only `## cwd_aliases` parsed). (#57)
- A worker busy with a long task is no longer reaped by the heartbeat sweep and its task re-dispatched to another worker. (#62)
- Codex workers pin `model_reasoning_effort=low` for headless runs, so short tasks don't deep-reason for tens of seconds. (#63)

[0.6.0]: https://github.com/Christianye/postline/releases/tag/v0.6.0

## [0.5.0] — 2026-06-11

The **Doorbell** release: a remote bridge between postline and Claude Code workers. postline can dispatch a repo-scoped task to a `cc-worker` registered for that repo on any host, and stream the worker's progress back into the same IM message in place. All packages bumped 0.4.0 → 0.5.0 (lockstep).

### Added

- **Doorbell endpoints + queue + registry.** An HMAC-authed HTTP surface (bound to loopback) with a per-cwd FIFO task queue, worker registry, and ~30s long-poll. Off by default; enable with `doorbell.enabled = true`. (#42)
- **routing.md router.** A `routing.md`-driven matcher decides per inbound message whether to dispatch to a worker, answer locally, or reject — with atomic-swap hot reload, override prefixes, and destructive-verb refusal when no worker is registered. (#43)
- **`cc-worker` subcommand.** Registers a Claude Code session's working directory as a doorbell worker and runs dispatched tasks headless. (#44)
- **Live progress + status queries.** ETA validation, debounced in-place progress edits to the IM message, and `status` / `workers` queries. (#45)
- **`postline doctor --strict`** liveness probe and a design-review push poller for proactive notifications. (#36, #39)

[0.5.0]: https://github.com/Christianye/postline/releases/tag/v0.5.0

## [0.4.0] — 2026-06-02

Three concurrent improvements shipped together — one cost-saving (prompt caching), one cost-routing (haiku for trivial), one tooling (SDK bump that lets us drop a `unknown` cast). Plus an out-of-band CLI subcommand + systemd timer for daily reports.

### Added

- **Prompt caching** for the system prompt + tool array. Both Bedrock (`cachePoint: {type: 'default'}`) and Anthropic (`cache_control: {type: 'ephemeral'}`) now mark cache breakpoints on the stable prefix. **Empirical caveat**: when running on a cross-region inference profile (e.g. `us.anthropic.claude-opus-4-7`), cache hit rate is unstable because each request may land on a different region with its own cache pool. Cache *writes* still succeed reliably; *reads* hit intermittently when same-region routing falls within the 5-minute TTL. Trade-off accepted: failover beats hit rate. (#21, #22, #23, #24, #25)
  - **Pre-1.0 API change**: `TurnRequest.system` is now `readonly SystemSegment[]` instead of `string`. Out-of-tree consumers calling provider `stream()` directly need to migrate `system: 'foo'` → `system: [{ text: 'foo' }]`.
- **Model routing** (opt-in via `cfg.routing`). When `enabled`, the host classifies inbound text per turn and routes trivial queries (short, single-line, no English/Chinese action verbs, no shell/path/URL tokens) to a cheaper `smallModel` (default `haiku-4-5`) instead of the primary. ~10x cost saving on small queries with zero impact on hard-query quality. Off by default. Conservative classifier prefers the primary on ambiguity. Emits `feishu_routing_small_model` log when the small model is picked. (#26)
- **`postline daily-report`** CLI subcommand + systemd timer template (`deploy/systemd/postline-daily-report.{service,timer}.template`). Builds a markdown digest (usage tokens + USD per model, cache split, systemctl-derived service health, history-orphan audit, journalctl signal counts incl. routing hit rate) and either prints or `feishu_send`-s it. Runs daily at 01:00 UTC by default; standalone process — does not touch `cc.service`. Enable with `sudo systemctl enable --now postline-daily-report.timer`. (#27)

### Changed

- **`@anthropic-ai/sdk`** bumped from `^0.40.0` to `^0.100.1`. The 0.40 SDK still typed `thinking.type` as `'enabled' | 'disabled'` only, forcing an `as unknown as ...` cast on the adaptive-thinking request added in #13. 0.100.1 ships canonical `ThinkingConfigAdaptive` + `OutputConfig` types, so the provider passes through cleanly. Stream-event shape unchanged across the version range; existing handling untouched. (#20)

### Migration notes

- Replace `cfg.inference.thinking.budgetTokens: number` with `cfg.inference.thinking.effort: 'low' | 'medium' | 'high' | 'max'` if you opted into thinking via 0.3.0 and pinned a budget. (Same migration was already required when 0.3.0 shipped; called out here for completeness.)
- Replace `system: 'foo'` with `system: [{ text: 'foo' }]` if you call provider `stream()` directly outside the workspace.

[0.4.0]: https://github.com/Christianye/postline/releases/tag/v0.4.0

## [0.3.0] — 2026-06-02

Three concurrent feature increments shipped together. All ten workspace packages bump together. The headline is extended-thinking support; the rest is operations / observability.

### Added

- **Extended thinking (adaptive)** — `inference.thinking: { enabled, effort }` config, opt-in. When enabled the provider asks the model to emit a thinking block before its visible answer; postline streams thinking deltas live to the seed message but does **not** persist them — each turn's reasoning is independent (no signature roundtrip overhead, simpler multi-turn semantics). Default `effort: 'high'` (always think); `'low' | 'medium' | 'high' | 'max'` supported. Wiring spans `@postline/core` (`'thinking_delta'` `StreamChunk` variant + `TurnLoopConfig.onThinkingDelta` hook + `TurnRequest.thinking` field), `@postline/providers` (bedrock + anthropic both honour the request and surface deltas), and `@postline/adapters-feishu` / `@postline/cli` (live `💭 …` rolling placeholder in the seed message during silent windows). (#12, #13)
- **`postline_stats action='history_audit'`** — operators can ask the bot to dry-run orphan-detection across every conversation jsonl on disk and surface the chats with the most orphan rows. Pure inspection — no mutation. Output ranks the top-N (default 5, capped 50) files by orphan count plus per-file `orphan_tool_use` / `standalone_tool` / corrupt-line counts. New `auditHistoryMessages(msgs)` and `auditHistoryDir(dir)` helpers exported from `@postline/cli`'s history-fs. (#11)

### Changed

- **Adaptive-thinking protocol** — fixed at the provider layer. PR #12 originally used `thinking.type='enabled'` + `budget_tokens`, which Bedrock opus-4-7+ rejects with `"thinking.type.enabled" is not supported for this model`. Switched to `thinking.type='adaptive'` + `output_config.effort` per the [Bedrock adaptive-thinking docs](https://docs.aws.amazon.com/bedrock/latest/userguide/claude-messages-adaptive-thinking.html). Critical Bedrock detail: `output_config.effort` must live in a sibling object (not inside `thinking`) or you get a ValidationException. **Pre-1.0 API change**: `inference.thinking.budgetTokens` (number) → `inference.thinking.effort` (`'low' | 'medium' | 'high' | 'max'`). Same shape change in `@postline/core` `TurnRequest.thinking` and `TurnLoopConfig.thinking`. (#13)

### Known limitations

- **Bedrock adaptive thinking is stream-silent on opus-4-7** — empirically (postline diagnostic PR #14, reverted PR #15) Bedrock does NOT emit `reasoningContent` SSE deltas in adaptive mode. The model thinks (`output_tokens` reflects it; e.g. 5129 vs ~200 baseline on a non-trivial query), but no incremental thinking text reaches the client. The `thinking_delta` hook never fires; the `💭` rolling placeholder will not render. The `reasoningContent` handler in the bedrock provider is kept in place for older models (`thinking.type='enabled'` on claude-3-7 / opus-4-5 etc.) where Bedrock does emit deltas. To get `💭` visibility today the only path is the Anthropic native API (untested in postline prod).

### Internal

- **CLI runtime-state suffix** (no public-package change). `@postline/cli` injects a static `## Runtime state` block into the Feishu bot's system prompt at process startup — pid, started_at, node version, git HEAD, model, thinking / streaming / requesterOnly flags. Computed once; stable for process lifetime → keeps the Anthropic prompt cache stable. Closes a class of self-state hallucination ("did I just restart?", "is my code stale?"). When thinking is enabled on Bedrock, an extra confrontational fact-block appended ("Wire format is `type: 'adaptive'`, server-side IS reasoning, do NOT diagnose 'stale code' or 'needs rebuild'") so the bot doesn't invent a deploy issue when asked about missing `💭`. (#16, #17, #18)

### Migration notes

- If you set `inference.thinking.budgetTokens` in `postline.config.ts`, replace it with `inference.thinking.effort: 'high' | 'medium' | 'low' | 'max'`. The legacy `enabled`+`budget_tokens` shape was rejected on opus-4-7 anyway, so nobody on a current model was actually using it.

[0.3.0]: https://github.com/Christianye/postline/releases/tag/v0.3.0

## [0.2.0] — 2026-06-01

Five concurrent feature increments shipped together. All ten workspace packages bump together. No runtime compat breaks for downstream config consumers; one in-tree adapter API shape change in `@postline/adapters-feishu` (see "Changed" below).

### Added

- **Keep-alive status events** during silent windows (`@postline/core` + `@postline/providers`). Three synthetic heartbeat kinds — `attempt_started` (provider opened a stream, `detail` = model id), `thinking` (stream open, no text yet), `tool_running` (`detail` = tool name) — exposed as a new `'status'` `StreamChunk` variant and a `TurnLoopConfig.onStatus` hook. Bedrock + Anthropic providers emit `attempt_started` per model attempt and `thinking` once the stream is open. The Feishu adapter renders them as plain-text placeholders ("Calling claude-opus-4-7…", "Thinking…", "Running tool: bash…") in the seed message during silent windows; placeholders never overwrite real text once it streams in within the same iteration. New iteration boundaries reset the gate so the next placeholder is visible. (#4)
- **HTTP-level retry with exponential backoff** (`@postline/providers`). Bedrock + Anthropic now retry the stream-creation HTTP call on transient errors (Throttling, ServiceUnavailable, InternalServer, RateLimit, network ECONNRESET / ETIMEDOUT, etc.) up to 2 times per model attempt before falling through to the next fallback model. Backoff is base-4 exponential — 100ms, 400ms, 1600ms (capped at 5s). Permanent errors (Validation, AccessDenied, NotFound, abort) bypass retry. Each retry logs `provider_retry` with `{provider, model, attempt, delayMs, errName, err}`. New shared helper `withRetry()` + `isRetryableError()` exported from `@postline/providers`. (#6)
- **In-process metrics** (`@postline/core` + propagated through providers + turn loop + history sanitization). Lightweight Counter + cumulative-bucket Histogram primitive (no external deps). Canonical postline metric set: `provider_attempt_total{provider, model, outcome}`, `provider_retry_total{provider, model}`, `provider_fallback_total{provider, from_model, to_model}`, `turn_total{outcome}`, `tool_total{name, outcome}`, `history_orphan_dropped_total{kind}`, plus histograms `tool_duration_ms{name, outcome}` and `turn_duration_ms{outcome}`. Wiring is opt-in via dependency injection — every consumer accepts an optional `MetricsRegistry`. The Feishu CLI command instantiates `createPostlineMetrics()` and threads it through. New public exports: `createMetricsRegistry`, `createPostlineMetrics`, `MetricsRegistry`, `MetricsSnapshot`, `CounterSnapshot`, `HistogramSnapshot`, `MetricLabels`, `DEFAULT_DURATION_BUCKETS_MS`, `POSTLINE_METRICS`. The `postline_stats` tool gains an `metrics` action that dumps a human-readable snapshot (counter totals + histogram count/avg/p50/p95 per series) — the bot can now report its own throttle / failover / orphan-recovery activity in chat without journalctl access. (#8)

### Changed

- **Approval-card UI swaps to a resolved state on click** (`@postline/adapters-feishu`). Clicking Approve / Deny on the dangerous-tool approval card atomically replaces the original red "Approval required" card with a green ✅ "Approved" / grey ❌ "Denied" variant — buttons removed, signed by clicker open_id and timestamp. The new card payload rides back inline on the `card.action.trigger` response (no extra API round-trip). `buildApprovalCard` config now sets `update_multi: true` (Feishu requires it for inline replacement); `CardActionResponse` gains an optional `card?: { type: 'raw'; data }` field; new exported helper `buildResolvedCard`; `PendingActions` gains a `get(id)` accessor on `@postline/core`. **Already shipped to prod on 2026-05-30 as part of the "two reliability fixes" rollback path**, formally batched into 0.2.0 here for the changelog narrative. (originally landed in 0.1.10)
- **Approval-card preview formatter** (`@postline/adapters-feishu`, **breaking API change**). The card body is now rendered per tool instead of a single `JSON.stringify(args)` blob: `bash` / `bash_read` → command in a fenced bash block + cwd / timeout footnotes; `fs_write` / `fs_edit` → path + content snippet (or old/new strings); `fs_read` → path; `web_fetch` → URL + Accept; `feishu_send` → target + text + mentions; `gh_query` / `gh_action` → reconstructed `gh …` in bash block; `skill_run` → skill + script + JSON-quoted argv + timeout; unknown tool → JSON fallback. Truncation is per-field with explicit `[…N chars truncated]` markers. **Breaking:** `ApprovalCardParams.argsPreview: string` is replaced by `args: Record<string, unknown>`; the formatter runs inside `buildApprovalCard`. New export `formatToolArgsPreview(toolName, args)` for reuse. The only in-tree caller (`@postline/cli`) is updated. Out-of-tree consumers calling `buildApprovalCard` directly need to swap the field. (#7)
- **Approval-card and slash-command resolution restricted to the requester by default** (`@postline/config`). Allowlist members other than the original requester can no longer approve a dangerous action on the requester's behalf; both the card-button click path and the `/approve <id>` / `/deny <id>` text fallback go through the same authorization function. Configurable via the new `feishu.approval` block: `requesterOnly: true` (default), `admins: string[]` (open_ids that may approve any pending action regardless). Admin overrides emit an audit log `feishu_approval_override` with `{actionId, requester, override_by, tool}`; rejected non-requester non-admin clicks emit `feishu_approval_rejected_not_requester`. To revert to legacy "anyone in allowlist can resolve" behaviour, set `requesterOnly: false`. (#5)

### Fixed

- (Already shipped in 0.1.10, listed here for upgrade-path completeness.) Orphan `tool_use` rows no longer poison conversation history when a stream errors mid-flight; the synthetic-tool_result save-side guard plus `sanitizeHistory()` load-side pass keep the bricked-chat scenario from reproducing. (#1)

### Migration notes

If you call `buildApprovalCard` directly from outside the workspace, swap `argsPreview: string` for `args: Record<string, unknown>`. Everyone else: no action needed; defaults preserve all prior behaviour modulo the requester-only gate (which is the intended security tightening — set `feishu.approval.requesterOnly: false` if you depended on bystander approval).

[0.2.0]: https://github.com/Christianye/postline/releases/tag/v0.2.0

## [0.1.10] — 2026-05-31

Two reliability fixes for the Feishu surface, shipped together. All ten workspace packages bump together.

### Fixed

- **Orphan `tool_use` no longer poisons conversation history.** When a stream errored or hit `max_tokens` after the assistant emitted a `tool_use` block, the turn loop persisted the assistant message but no matching `tool_result`. Subsequent turns then reloaded a malformed `messages[0]` and the Anthropic API rejected the request with `Expected toolResult blocks at messages.0.content for the following Ids`, bricking the chat across all fallback models. `@postline/core` now injects a synthetic `isError` `tool_result` on abort so persisted history stays well-formed, and `@postline/cli`'s history loader adds a `sanitizeHistory` pass that drops orphan rows already on disk — so existing polluted jsonl files heal automatically on the next turn rather than requiring a manual wipe. Production hit this on 2026-05-29 across all four fallback models. (#1)

### Changed

- **Approval card now swaps to a resolved state on click.** Clicking Approve or Deny on a dangerous-tool approval card atomically replaces the original red-bordered "Approval required" card with a resolved variant — green ✅ "Approved" / grey ❌ "Denied", buttons removed, signed by the clicker's open_id and the resolution timestamp. The new card payload rides back inline on the `card.action.trigger` response, so the swap is latency-free with no extra API round-trip.
  - `buildApprovalCard` config now sets `update_multi: true` (Feishu requires it on the original card before accepting an inline replacement)
  - `CardActionResponse` gains an optional `card?: { type: 'raw'; data }` field
  - `buildResolvedCard({ toolName, actionId, decision, actorOpenId, decidedAtMs })` is newly exported from `@postline/adapters-feishu`
  - `PendingActions` gains a `get(id)` accessor so adapters can read entry metadata before `approve()` / `deny()` removes it
  - Approval cards posted by older versions (no `update_multi`) keep the legacy toast-only UX; no migration needed. (#2)

[0.1.10]: https://github.com/Christianye/postline/releases/tag/v0.1.10

## [0.1.9] — 2026-05-21

P2b "Skill script sandbox" item. All ten workspace packages bump together.

### Added

- **`skill_run` sandbox tool** — skills bundling a `scripts/` subdirectory (e.g. `pdf`, `docx`, `aws-html-slides`) can now be executed directly through a single global `skill_run` tool instead of forcing the model to chain through `bash`. Risk = `write`, so every call still goes through `/approve`. The tool registers automatically iff at least one discovered skill ships `scripts/`. Calls accept `{skill, script, args?, timeout_ms?}`. Sandbox constraints enforced before spawn: skill id must be in the discovery snapshot, `script` realpath must lie inside `scriptsDir` (`..` traversal and outbound symlinks rejected), target must be a regular file with execute bit set, subprocess is `spawn`ed directly (not `bash -c`) so argv passes through verbatim with no shell expansion, env is scrubbed to `PATH`/`HOME`/`LANG`/`LC_ALL`/`USER`/`TMPDIR` (notably no `AWS_*`, `ANTHROPIC_*`, `FEISHU_*`), default timeout 60s with 300s hard cap, `SIGTERM` → `SIGKILL` on timeout or abort, stdout+stderr returned truncated to 64KB.
- **`Skill.hasScripts` / `Skill.scriptsDir`** — populated at discovery time. The system-prompt fragment for skills shipping `scripts/` now carries a `skill_run` hint so the model is reminded the option exists.

### Deferred

- MCP `prompts` slash-command UX (`/prompts` list, `/prompt <server>/<name>` invoke) — model-facing tools shipped in 0.1.8; user-typed slash commands still on the roadmap.
- MCP OAuth + WebSocket transports (stdio + HTTP/SSE remain the supported set).
- Stronger isolation for skill scripts (cgroups / namespaces / firejail) — current sandbox is path containment + env scrub + risk gate, no process-level isolation.

[0.1.9]: https://github.com/Christianye/postline/releases/tag/v0.1.9

## [0.1.8] — 2026-05-20

Second half of the P2b "resources and prompts" roadmap item. 0.1.7 surfaced resources; this surfaces prompts. All ten workspace packages bump together.

### Added

- **MCP prompts surface** — when an MCP server advertises the `prompts` capability in its handshake, postline now registers two synthetic tools per server automatically: `mcp_<server>_prompts_list` (risk=`read`, optional `cursor` for pagination, truncates to 100/page with a `nextCursor` hint; each line shows the prompt name, optional description, and required argument names suffixed with `*`) and `mcp_<server>_prompts_get` (risk=`read`, `name` required, optional `arguments` object with values coerced to strings; returns a `<role>: <text>` transcript prepended with the prompt's description when present, non-text parts render as `[unsupported content type: <mime>]` markers). Both skip the `/approve` gate — fetching a prompt produces metadata-shaped messages and performs no side effects. Capability-gated off the MCP handshake; servers that don't advertise prompts are unaffected.
- **`McpClientHandle.listPrompts` / `getPrompt`** — sibling accessors to the resources methods added in 0.1.7. New types `McpPrompt`, `McpPromptArgument`, `ListPromptsResult`, `GetPromptResult`.

### Deferred

- Slash-command UX (`/prompts` list, `/prompt <server>/<name>` invoke) for prompts triggered directly by the user — model-discoverable tools land first; user-typed slash commands require turn-loop hooks and ship later.
- MCP OAuth + WebSocket transports (still on the roadmap; stdio / HTTP+SSE remain the supported set).

[0.1.8]: https://github.com/Christianye/postline/releases/tag/v0.1.8

## [0.1.7] — 2026-05-13

First half of the P2b "resources and prompts" roadmap item. All ten workspace packages bump together.

### Added

- **MCP resources surface** — when an MCP server advertises the `resources` capability in its handshake, postline now registers two synthetic tools per server automatically: `mcp_<server>_resources_list` (risk=`read`, optional `cursor` for pagination, truncates to 100/page with a `nextCursor` hint) and `mcp_<server>_resources_read` (risk=`read`, `uri` required, non-text parts render as `[unsupported content type: <mime>]` markers). Both skip the `/approve` gate — MCP resources are always safe to read. Capability-gating is authoritative: servers that only expose `tools` are unaffected, and `tools/list` is also now gated, so a prompts-only server no longer errors out.
- **`McpHealth.hasResources` / `hasPrompts`** — surfaced for `postline doctor`-style introspection.

### Deferred

- MCP `prompts` surface — coming in 0.1.8 as slash commands (`/prompts` list, `/prompt <server>/<name>` invoke).
- Resource change notifications / subscribe — current version is pull-only.

[0.1.7]: https://github.com/Christianye/postline/releases/tag/v0.1.7

## [0.1.6] — 2026-05-12

Symmetry patch: history is now searchable the same way memory already is. All ten workspace packages bump together.

### Added

- **`history_search` tool** — grep across persisted conversation history (every `*.jsonl` file in `cfg.history.dir`). Literal-default, regex opt-in, case-insensitive, `max_hits` cap, optional `hours` window via file mtime. Symmetric with `memory_search`. Returns conversation hash + role + snippet around the match; extracts text from `text` / `tool_use` / `tool_result` content parts. Registry fails loudly if `history_search` is enabled without `cfg.history = { kind: 'fs', dir }`. 14 new tests.

[0.1.6]: https://github.com/Christianye/postline/releases/tag/v0.1.6

A self-reflection tool so the bot can answer *"how much did I cost this morning?"* and *"are you healthy?"* inside the chat. All ten workspace packages bump together.

### Added

- **`postline_stats` tool (bot self-reflection)** — a single `read` tool with two actions. `action: 'usage'` aggregates token + USD usage from the last N hours (default 24) so the model can answer *"how much did I cost this morning?"*. `action: 'health'` reports uptime, memory dir state (git clean/dirty), history conversation count, usage-log size, and pending-approval count so the bot can self-report status to the chat. 10 new tests covering window filtering, unknown-model USD handling, corrupt-line tolerance, and live pending counts. Enabled per deployment by adding `'postline_stats'` to `tools.builtin` in `postline.config.ts`.
- **`ToolBuildContext` gains `historyDir` / `usageDir` / `pendingCountFn` / `processStartedAtMs`** — plumbed by `cmd-chat`, `cmd-feishu`, `cmd-ask` so tools like `postline_stats` get the data they need without reaching into global state.

[0.1.5]: https://github.com/Christianye/postline/releases/tag/v0.1.5

Live-typing in Feishu, a new PR-review cookbook recipe, and a handful of surface-polish items. All ten workspace packages bump together.

### Added

- **Feishu streaming output (live typing)** — opt in with `feishu.streaming: true`. The bot sends a seed message on the first text delta and edits it in place via `im.v1.message.update`, debounced (default 250ms, configurable via `feishu.streamingDebounceMs`) to stay well under Feishu rate limits. Text longer than 4500 chars spills over into follow-up messages; any edit failure falls open to the standard one-shot send. 10 new tests covering seed, debounce, overflow, failure fallback, redundancy skip, and no-delta turns.
- **`onTextDelta` hook on `runTurn`** — `@postline/core` now surfaces per-chunk deltas (with accumulated text + iteration index) so channel adapters can implement live UIs without peeking into the turn loop.
- **`FeishuChannel.sendText` + `editText`** — expose the feishu SDK's `im.v1.message.create`/`update` in a channel-native wrapper. Used by streaming; available to any future recipe that needs to post + edit.
- **COOKBOOK #11: PR diff review** — paste a `main..HEAD` diff request and the bot runs `skill_review` + `bash_read` (`git diff / show / log` are already allowlist-safe, no code change needed) to produce a checklist-style review. README quickstart mentions the new recipe count (11).

[0.1.4]: https://github.com/Christianye/postline/releases/tag/v0.1.4

Three "match what we claim" additions: conversations survive restart, every turn reports tokens + cost, and dangerous-tool approval becomes a button instead of a text command. All ten workspace packages bump together.

### Added

- **Filesystem-backed conversation history** — new `@postline/cli` history-fs store. Opt in with `cfg.history = { kind: 'fs', dir: '...' }`. Each conversation becomes a JSONL file (md5-hashed id for safe filenames), appended per turn. `systemctl restart cc` no longer wipes in-flight context. 12 tests.
- **Per-turn token + cost tracking** — `StreamChunk.usage` populated by both bedrock and anthropic providers (input / output / cache-read / cache-creation tokens). Pricing table in `@postline/core/pricing.ts` covers Claude 4 + 3.5 families with longest-prefix match. New `UsageRecorder` interface + optional `TurnDeps.usageRecorder`; opt-in JSONL persistence via `cfg.usage = { kind: 'fs', dir: '...' }`. 11 pricing tests.
- **`postline stats` subcommand** — aggregate `usage.jsonl` into a per-model table: calls, input/output tokens, cache R/W, estimated USD. Unknown models render as `?` rather than silent `$0`. `--json` for jq.
- **Feishu interactive approval card** — `dangerous` tool approval now posts an interactive message card with Approve (primary) / Deny (danger) buttons and a red header. Clicks fire `card.action.trigger`; the adapter validates the clicker against the open_id allowlist and returns a toast. Text `/approve <id>` and `/deny <id>` remain as fallbacks (unchanged semantics) for when the `card.action.trigger` event isn't subscribed or the card send fails. 5 card-builder tests.

### Fixed

- `postline --version` now reports the current package version.

[0.1.3]: https://github.com/Christianye/postline/releases/tag/v0.1.3

Sharpens the three ecosystem bridges (memory / skills / MCP) with a search tool, a `tools` listing subcommand, and HTTP/SSE support for remote MCP servers. All ten workspace packages bump together.

### Added

- **`memory_search` tool** — fourth memory op alongside `list`/`read`/`write`. Literal or regex grep across the memory dir, case-insensitive by default, line-anchored output with a `max_hits` cap. Scales to a few hundred files; intentionally not an embedding index. 11 new tests.
- **`postline tools` subcommand** — list every tool the turn runner would receive (builtin + MCP + skills) with `NAME / RISK / SOURCE` columns. `--json` for jq. Useful for screenshots and "what does the model actually see?" debugging.
- **MCP HTTP + SSE transports** — in addition to stdio, `type: 'http'` (aliased `'streamable-http'`) and `type: 'sse'` server configs. Auth is request-header based (`headers: { Authorization: 'Bearer ...' }`); full OAuth flow deferred. Remote MCP servers (Notion, Linear, etc.) plug straight in. 4 new config-loader tests.
- `postline doctor` distinguishes stdio (PATH-checked) from remote HTTP/SSE servers (not network-checked by design).

### Fixed

- Env-fallback loader default memory dir: `~/.cc/memory` → `~/.postline/memory` (brand alignment; `CC_MEMORY_DIR` still honoured for Phase 1 ops).
- README badge + "`pnpm test`" echo updated from 168 → 221 tests.
- `postline --version` reports current package version instead of a hardcoded `0.1.0`.
- `postline.config.example.ts` comment clarity improvements (MCP / skills blocks, empty-config semantics).

[0.1.2]: https://github.com/Christianye/postline/releases/tag/v0.1.2

## [0.1.1] — 2026-05-12

Ecosystem bridges: MCP client and Claude Code skill loader. Both read the same configs Claude Code / Claude Desktop write, so zero duplication for users who already live in that tooling. All ten workspace packages bump together.

### Added

- **MCP (Model Context Protocol) client** — new `@postline/mcp-client` package. Spawns stdio MCP servers declared in `~/.claude.json → mcpServers` and/or inline under `postline.config.ts → tools.mcp`, lists their tools, and exposes each as `mcp_<server>_<tool>` to the turn runner. Default risk tier `dangerous`; per-tool overrides supported. Fail-open on individual server failures, strict mode opt-in. 22 new tests.
- **Claude Code skill loader** — new `@postline/skill-loader` package. Walks `~/.claude/skills/<name>/SKILL.md`, parses frontmatter (`name` / `description` / `disable-model-invocation`), and exposes each skill as a `skill_<id>` tool (risk `read`). Non-hidden skills are advertised in the system prompt so the model picks one when the user's request matches. `include` / `exclude` filters; strict mode on malformed SKILL.md; tool-name collision detection. 31 new tests.
- `postline doctor` now reports `mcp: N server(s) configured, …` and `skills: N loaded (advertised/hidden split)`.
- Biome config now honours `.gitignore` via `useIgnoreFile: true` — local smoke/dev configs (gitignored) no longer trip `pnpm lint`.
- Docs: `docs/TOOLS.md → MCP` and `→ Claude Code skills` sections, two FAQ entries, ROADMAP marks Phase 2b MCP + skill-loader as shipped.

### Fixed

- Skill tool-name collisions (`aws-html-slides` vs. `aws_html_slides` both sanitising to `skill_aws_html_slides`) are now detected at orchestrator level — first discovered wins, others logged and skipped.
- Skill tools' `inputSchema` now includes `additionalProperties: false` for consistency with other postline tool schemas.

[0.1.1]: https://github.com/Christianye/postline/releases/tag/v0.1.1

## [0.1.0] — 2026-05-11

First public release. All seven workspace packages ship at `0.1.0` together.

### Added

**Core framework** (`@postline/core`)

- Four interfaces: `Provider`, `Channel`, `Tool`, `Memory`. Stable for the 0.x line.
- Risk-tiered tools: `read` (auto-approved), `write` (allowlist-gated), `dangerous` (requires `/approve` gate).
- Structured `Logger`, `Turn` runner with tool-use loop, secret redaction helpers.

**Providers** (`@postline/providers`)

- `bedrock` provider (default): AWS Bedrock Runtime, streaming, tool use, vision, prompt caching.
- `anthropic` provider: `@anthropic-ai/sdk` 0.40, identical capability surface.
- `ProviderSpec` tagged union + `createProvider()` registry for third-party drop-ins.

**Channels**

- `@postline/adapters-feishu` — Feishu/Lark long-connection WSClient. @mention triggering, group + DM, image input, docx/wiki/sheet URL parsing, message splitting at 4500 chars.
- `@postline/adapters-cli` — Local TTY REPL (`pnpm chat`).

**Built-in tools** (`@postline/tools-builtin`, 9 ids)

- `echo`, `web_fetch` (SSRF-guarded), `fs` (read/write/edit), `memory` (list/read/write, git-backed), `github` (gh_query/gh_action), `lark_docs` (doc/wiki/sheet/bitable), `bash_read` (allowlisted safe subset, auto-approved), `bash` (dangerous, approval-gated), `feishu_send` (proactive send, allowlist + rate-limited).

**CLI** (`@postline/cli`, 6 subcommands)

- `chat` — local REPL.
- `feishu` — long-connection bot runner.
- `ask <prompt>` — one-shot turn, prints final text, exits 0. Good for cron.
- `init` — scaffold `postline.config.ts` in cwd.
- `doctor` — env + dep + config diagnostics.
- `upgrade` — `git pull && pnpm install && pnpm -r build && systemctl restart cc` on deployed hosts.

**Config** (`@postline/config`)

- `postline.config.ts` with `defineConfig()` helper.
- Four-level resolution: explicit path → `POSTLINE_CONFIG` env → walk-up from cwd → env-only fallback.
- Node 22+ native TypeScript config loading (`--experimental-strip-types`).

**Deployment**

- Templated `deploy/systemd/cc.service.template` → rendered per host via `install.sh` (substitutes `{{USER}}`, `{{REPO_DIR}}`, `{{CC_HOME}}`, `{{NODE_BIN}}`).
- `deploy/upgrade.sh` for in-place rolling updates.
- Memory auto-sync via cron against a private git remote.

**Examples**

- `examples/minimal` — 20-line config, `bash_read` + `echo`.
- `examples/full` — every tool, both providers, both channels.
- `examples/daily-report` — cron-driven `postline ask` → feishu group post.

**Docs**

- `README`, `CONTRIBUTING`, `SECURITY`, `CODE_OF_CONDUCT`, `CHANGELOG`.
- `docs/`: `ARCHITECTURE`, `CONFIG`, `PROVIDERS`, `TOOLS`, `THREAT_MODEL`, `COOKBOOK` (10 recipes).

**CI & release**

- GitHub Actions matrix: ubuntu + macos × Node 22. Build → typecheck → test → lint → secret-scan.
- [changesets](https://github.com/changesets/changesets) configured for future per-package releases.
- `.gitignore` hardened against leaking `postline.config.ts`, `.env`, keys, editor state.

### Security

- Feishu scopes documented at minimum needed (`im:message` + `docx:document:readonly` family; `contact:*` explicitly excluded).
- Outbound network surface enumerated in `docs/THREAT_MODEL.md` (5 hosts).
- `feishu_send` hard allowlist of `chat_id` / `open_id` targets, default empty = disabled.
- `bash` classifier splits each sub-command separately — `2>&1;` no longer masks a `;` chain.
- Secret redaction on all tool outputs + log lines.
- Upstream axios CVEs tracked as upstream-pinned (`@larksuiteoapi/node-sdk`); no direct postline exposure.

### Stats

- 168 tests passing, 0 typecheck errors, 0 lint warnings.
- 191 production dependencies, zero GPL/AGPL (MIT/Apache/BSD only).
- Git history scrubbed of personal email and instance identifiers before publication.

[0.1.0]: https://github.com/Christianye/postline/releases/tag/v0.1.0

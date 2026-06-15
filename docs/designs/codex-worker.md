# Codex worker + selector routing · design plan

> Status: **FROZEN v1 · 2026-06-15** · operator-approved (2 PR, registry Option A, OQ leans) · Author: mac CC · Sole owner: mac CC
> Lifecycle: design → operator review → freeze → impl
> Trigger: agent-axis second slot. A `cc-worker` today always spawns
> `claude -p`; a codex worker spawns `codex exec` instead. Unlocks the
> 3-segment wake-prefix selector (`!pl@codex@repo`) being a real choice.

---

## 0 · Why now

The IM axis (lark / telegram / slack) is full for `cc`. The wake-prefix
selector (`!pl@<selector>@<repo>`) is parsed + logged but **not routed**:
with only `cc` workers, there's no second agent to pick. A codex worker is
the prerequisite for selector routing to mean anything.

Two pieces:
1. **codex worker** — register with `agentKind: 'codex'`, spawn `codex exec`.
2. **selector routing** — dispatch keyed on `(cwd, agentKind)` so
   `!pl@cc@repo` vs `!pl@codex@repo` reach different workers.

---

## 1 · codex CLI headless — verified 2026-06-15

`codex exec --json` emits JSONL events (the stream-json analog). Probed
`codex-cli 0.139.0`:

| Flag | Role |
|---|---|
| `codex exec "<prompt>"` | non-interactive run (vs `claude -p`) |
| `--json` | JSONL events to stdout |
| `-C <dir>` / `--cd` | working directory (vs spawn `cwd`) |
| `-m <model>` | model override |
| `-s read-only \| workspace-write \| ...` | sandbox policy |
| `-o <file>` | write final message to a file |
| `--skip-git-repo-check` | allow non-repo cwd |

### Event shapes (vs Claude stream-json)

| codex event | Claude analog | progress mapping |
|---|---|---|
| `{type:'thread.started', thread_id}` | `system/init` | init |
| `{type:'turn.started'}` | — | (ignore) |
| `{type:'item.completed', item:{type:'agent_message', text}}` | assistant `text` | text progress; **last one = final result** |
| `{type:'item.started'\|'completed', item:{type:'command_execution', command, exit_code, status}}` | `tool_use` (Bash) | `🔧 <command>` |
| `{type:'turn.completed', usage}` | `result` | terminal (no separate result text — use last agent_message, or `-o`) |

**Key differences from Claude:**
- **No single `result.result` field.** Final text = the last
  `agent_message` item (or read `-o <file>`). The runner must track "last
  agent_message" and use it as `ResultBody.text`.
- **Tools are all `command_execution`** (one shell tool), not typed
  Read/Edit/Bash. The `🔧` label is just the command string, clipped.
- codex auto-reads local `SKILL.md` / `AGENTS.md` — noise in the stream we
  ignore (only agent_message + command_execution map to progress).

---

## 2 · Worker design

### 2.1 · Agent kind selection

`cc-worker start` gains `--agent <cc|codex>` (default `cc`), or env
`CC_WORKER_AGENT_KIND`. The kind drives:
- what gets reported in registration (`agentKind`, already wired)
- which spawn+parse path `runTask` takes

### 2.2 · runTask split

Today `runTask` (runner.ts) hardcodes `claude -p … --output-format
stream-json` + a Claude-event parser. Refactor:

```
runTask(params)
  → if agentKind === 'codex': runCodexTask()  (codex exec --json + codex parser)
  → else:                     runClaudeTask()  (current path, unchanged)
```

Both emit the same `ProgressBody` (`summary` + structured `event`
`{kind,label}`) + `ResultBody` (`status`, `text`). The doorbell + IM
bridges already consume that shape — **no bridge change needed** (the
narrow-waist progress protocol pays off again).

### 2.3 · codex parser (`runCodexTask`)

- spawn `codex exec --json -C <cwd> --skip-git-repo-check -s <sandbox> "<preamble+prompt>"`
- JSONL line-buffer (same chunk-boundary handling as the claude parser)
- per event:
  - `agent_message` → `event {kind:'text', label}`; **stash as `lastAgentMessage`**
  - `command_execution` (started) → `event {kind:'tool', label: clip(command)}`, eager flush
  - `thread.started` → `event {kind:'init'}`
- on exit: `ResultBody.text = lastAgentMessage` (fallback to `-o` file if empty)
- sandbox default: **`workspace-write`** (codex needs to edit in the repo;
  `read-only` blocks real coding tasks). Approval/danger handling deferred
  (OQ-C2).

### 2.4 · Open questions

- (OQ-C1) Headless preamble: Claude's preamble injects 中文-default + ETA
  tag instructions. codex honours `AGENTS.md` in-repo + a prompt prefix.
  Reuse the same preamble text, or codex-specific? Lean: **same preamble**
  (it's plain instruction text; codex reads it fine).
- (OQ-C2) Approval: the cc path has no in-worker approval (the bridge
  gates dangerous *bridge* tools; the headless CC/codex runs with its own
  sandbox). codex `-s workspace-write` + `--dangerously-bypass-…` spectrum
  — which sandbox for dispatched tasks? Lean: **`workspace-write`** (edit
  the repo, no network/system), document it; never auto-bypass.
- (OQ-C3) ETA: Claude emits `<eta>` on request; codex won't. Just omit ETA
  for codex tasks (progress still flows). Lean: **omit**, no special-casing.

---

## 3 · Selector routing — dispatch by (cwd, agentKind)

Today the registry is **one active worker per cwd** + the queue is
per-cwd. `!pl@cc@repo` and `!pl@codex@repo` resolve the same cwd, so they
can't reach different workers. To make the selector real:

### 3.1 · The minimal change

The selector (`decision.selector`) is already parsed + carried. The gap is
purely in *worker selection at dispatch*. Options:

- **Option A — registry keyed by (cwd, agentKind).** Allow one active
  worker per `(cwd, agentKind)` pair instead of per cwd. Dispatch picks the
  worker whose agentKind matches the selector (or any, if no selector).
  Bigger change: registry's latest-wins + standby promotion logic is
  per-cwd today; becomes per-(cwd,agentKind).
- **Option B — filter at dispatch, keep registry per-cwd.** Registry stays
  per-cwd (still one active worker per cwd), but a worker advertises its
  agentKind; if the selector doesn't match the active worker's kind, reply
  "no <kind> worker for <repo>". This is **honest but limited**: you can't
  run cc + codex on the *same* repo concurrently.
- **Option C — selector matches host OR agentKind, registry per (cwd,kind,host).**
  Full generality. Most code.

**Lean: A.** It's the natural model ("a worker per repo per agent kind"),
matches the `!pl@codex@repo` mental model, and the registry refactor is
contained (key the `cwdOrder` map on a composite key). B is a stopgap that
breaks the moment the operator wants cc+codex on one repo (the whole point).
C over-generalises host before there's demand.

### 3.2 · Scope flag

Selector routing (§3) is **separable from the codex worker (§2)**. The
codex worker is useful immediately (run `!pl@<repo>` with a codex worker
registered for a repo that has no cc worker). Selector routing only matters
once cc + codex coexist on one repo. Suggest **two PRs**:

```
PR-AGENT-1 · codex worker  (runTask split + codex parser + --agent flag)
PR-AGENT-2 · selector routing  (registry (cwd,agentKind) key + dispatch match)
```

PR-AGENT-1 alone lets you dogfood codex via telegram; PR-AGENT-2 makes the
selector segment functional.

---

## 4 · Affected surface

PR-AGENT-1:
- `packages/cli/src/cc-worker/runner.ts` — split `runTask` → `runClaudeTask` + `runCodexTask`; codex JSONL parser + label formatter
- `packages/cli/src/cmd-cc-worker.ts` — `--agent` flag / `CC_WORKER_AGENT_KIND` env → `agentKind` + spawn selection
- `docs/cc-worker.md` — document `--agent codex`
- tests: codex parser fixture (real captured JSONL), final-text-from-last-agent_message

PR-AGENT-2:
- `packages/doorbell/src/registry.ts` — composite `(cwd, agentKind)` key for active/standby
- `packages/doorbell/src/coordinator.ts` — dispatch honours `selector`
- `packages/core/src/router/matcher.ts` — (already carries `selector`; maybe pass through)
- tests: two workers same cwd diff kind → selector picks the right one

---

## 5 · Self-review checklist

- [ ] codex `agent_message`-as-final-text: does a multi-message turn ever
      leave the wrong "last" message? (Use `-o <file>` as the authoritative
      source; treat stream agent_messages as progress only.)
- [ ] sandbox default `workspace-write` — safe enough for dispatched tasks,
      or does it need the bridge allowlist gate too?
- [ ] registry (cwd,agentKind) key — does it break the existing per-cwd
      heartbeat sweep / latest-wins / standby tests? (They should still hold
      per composite key.)
- [ ] backward compat: a cc-only deployment (no codex) behaves identically
      after both PRs (selector absent → any-kind match → same as today).

## Changelog

- **v1 · 2026-06-15 · mac CC**: initial draft. codex CLI headless probed
  (`codex exec --json`, JSONL events mapped to the progress protocol). Two
  PRs: PR-AGENT-1 codex worker (runTask split, same ProgressBody → no
  bridge change), PR-AGENT-2 selector routing (registry (cwd,agentKind)
  key). Leans: same preamble, workspace-write sandbox, omit ETA, registry
  Option A. Awaiting operator review on OQ-C1..3 + the §3.1 registry option.
```

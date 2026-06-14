# Worker observability · live progress to IM + local terminal

> Status: **FROZEN v1 · 2026-06-14** · Author: mac CC · Sole owner: mac CC · operator-approved
> Lifecycle: design → operator review → **freeze (this rev)** → impl (PR-OBS-1 before telegram)
> All 6 OQs resolved at the recommended lean (§2.3 / §3.3). PR-OBS-1 lands before the telegram adapter.
> Trigger: operator wants to *see what a dispatched worker is doing* — both
> in the IM (lark) reply, and in a local terminal (iTerm2 / Wave), the way an
> interactive Claude session shows tool calls + thinking live.

---

## 0 · The question being answered

"I send `!pl@postline ...` from lark. That wakes a cc-worker process. Can I
**see the process**, both in lark and in my terminal, like I see an interactive
Claude session now?"

Two surfaces, very different difficulty:

1. **In lark** — richer live progress in the Feishu reply. Medium effort, no new
   infra. (§2)
2. **In a local terminal** — watch the worker's activity from iTerm2/Wave.
   Architectural: headless `claude -p` has no TUI; it's a stdin/stdout pipe
   process, separate from your interactive session. Needs a new component. (§3)

---

## 1 · How it works today (ground truth, code-read 2026-06-14)

```
iTerm2: claude → /cc-worker start
   → registers with doorbell, long-polls for tasks
lark: !pl@postline <text>
   → postline enqueues, the polling worker picks it up
   → worker spawns `claude -p <preamble+text>`   (packages/cli/src/cc-worker/runner.ts:249)
   → child stdout buffered; every 5s a "progress" POST fires with
     summary = last 3 lines of stdout, clipped to 600 chars
   → on exit, final stdout → /mac/result → edited into the lark message
```

Key facts:

- The headless child is spawned with **plain `claude -p <prompt>`** — default
  output format is the **final text answer only**. No structured events.
- "Progress" shown in lark = a coarse **tail-of-stdout snapshot**, not real tool
  calls or thinking. Good enough to show liveness; not "what it's doing".
- The headless child is a **separate process** from your interactive iTerm2
  Claude. They don't share a session. Nothing the worker does appears in your
  interactive window — by construction.
- Progress edit cadence: 5s debounce, both worker-side (POST) and bridge-side
  (Feishu edit). `🟡 cc@postline · mac · #id running · <tail>`.

---

## 2 · Surface 1 — richer live progress in lark

### 2.1 · The lever: `--output-format stream-json`

`claude -p` supports `--output-format stream-json --verbose` (and
`--include-partial-messages` for token-level deltas). Verified 2026-06-14; the
event stream is newline-delimited JSON:

| Event `type` | Carries | Use for progress |
|---|---|---|
| `system` / `init` | session id, cwd, model, tool list | "worker started, model X" |
| `assistant` | `content[]`: `text` / `tool_use {name, input}` / `thinking` | **"🔧 Bash: pnpm test", "💭 thinking", partial text** |
| `user` | `tool_result` | "✓ tool returned" |
| `result` | final text, cost, duration, usage | terminal edit (already handled) |
| (partial) | text deltas | token-level streaming if `--include-partial-messages` |

This is exactly the material an interactive session renders. Switching the
worker to parse it turns lark progress from "last 3 stdout lines" into a real
activity feed.

### 2.2 · Design

- **runner.ts**: spawn `claude -p <prompt> --output-format stream-json --verbose`.
  Replace the line-buffer/tail logic with a **JSONL event parser**. Per event,
  derive a compact progress descriptor:
  - `tool_use` → `🔧 <ToolName>` + a one-line arg hint (reuse the
    `formatToolArgsPreview` shapes the feishu approval card already has).
  - `thinking` → `💭 …` (optionally elided; thinking can be long/sensitive).
  - `text` → the latest assistant prose, clipped.
- **Progress protocol** (`ProgressBody` in runner.ts + doorbell types): add an
  optional structured field beyond the free-text `summary`, e.g.
  `event?: { kind: 'tool' | 'thinking' | 'text' | 'init'; label: string }`.
  Keep `summary` for back-compat / fallback.
- **Debounce**: keep ~the current cadence but make it **event-aware** — always
  flush on a `tool_use` boundary (tool transitions are the interesting moments),
  coalesce rapid text deltas. Respect lark's edit rate limit (≤ a few/sec).
- **cmd-feishu progress hook**: render the structured event into the in-place
  edit. Lines accumulate into a short rolling activity log:
  ```
  🟡 cc@postline · mac · #a3f8 · ETA ~25s
  💭 planning the review
  🔧 Bash: git show --stat
  🔧 Read: packages/core/src/router/matcher.ts
  🟢 done
  ```

### 2.3 · Decisions (resolved 2026-06-14)

- (OQ-A1) **Single elided line.** `💭 …` only; never the full thinking block.
  Config toggle `progress.showThinking` default **false**.
- (OQ-A2) **Message-boundary granularity.** No `--include-partial-messages` /
  token deltas in v1 — would hammer the lark edit rate limit for little gain
  over tool/thinking transitions. Revisit only if it feels laggy.
- (OQ-A3) **Keep the stdout-tail fallback.** `summary` (tail of stdout) stays
  the lowest common denominator; structured `event` is best-effort per agent
  kind. A future codex-worker that doesn't emit stream-json still shows liveness
  via `summary`.

---

## 3 · Surface 2 — watch from a local terminal (iTerm2 / Wave)

### 3.1 · Why it's not free

The dispatched work runs in a **headless child** (`claude -p`), which has no
terminal UI. Your interactive iTerm2 Claude is a *different* process. Three ways
to make worker activity visible locally, increasing cleanliness:

| Option | Mechanism | Verdict |
|---|---|---|
| A. Inject into the interactive session | Feed the lark task into the Claude session you already have open | ✗ Claude's interactive REPL has no external-injection API. Not feasible. |
| B. Tee headless output to a pane | Worker mirrors the stream-json to a tmux/Wave pane per task | Works, but couples the worker to a multiplexer + pane lifecycle. Messy. |
| C. **A `cc-worker watch` TUI** | New read-only command subscribes to the doorbell's progress stream and renders all in-flight tasks in a local terminal | ✓ Clean, decoupled, multiplexer-agnostic. **Recommended.** |

### 3.2 · Option C design (recommended)

A new read-only command — runs in any terminal (iTerm2, Wave, tmux pane):

```
$ cc-worker watch                 # or: postline watch (bridge-side)
┌─ postline · live ───────────────────────────────────────┐
│ #a3f8  cc@postline · mac   running 0:24                  │
│   💭 planning the review                                  │
│   🔧 Bash: git show --stat                                │
│   🔧 Read: matcher.ts                                     │
│ #b1c2  cc@NeuGate · ec2    queued                         │
└──────────────────────────────────────────────────────────┘
```

- **Data source**: the doorbell already receives every progress POST. Add a
  **read-only SSE/long-poll endpoint** (`GET /watch`, HMAC-authed like the rest)
  that streams progress + state events for all tasks. The watch client renders
  them. No new state store — it's a fan-out of what the coordinator already sees.
- **Where it runs**: bridge-side is simplest (the bridge holds the coordinator).
  `cc-worker watch --doorbell <url>` connects from anywhere (mac, ec2) over the
  same SSM tunnel the workers use.
- **Read-only**: watch never dispatches, approves, or mutates. Pure observability.
- **Renderer**: small TUI (the repo already bans heavy deps — use plain ANSI /
  a tiny line-redraw loop, no ink/blessed). Or a `--plain` mode that just
  appends lines (pipe-friendly, good for Wave's scrollback).

### 3.3 · Decisions (resolved 2026-06-14)

- (OQ-B1) **SSE.** `GET /watch` on the existing doorbell HTTP server; pure
  server→client stream, no work-claiming semantics. Long-poll's claim model is
  overkill for a read-only observer.
- (OQ-B2) **Live-only + snapshot-on-connect.** The coordinator's current
  in-flight task set is sent when a watcher attaches; after that, live events
  only. Tasks that finished before you attached aren't replayed. Full replay is
  later (needs a history store).
- (OQ-B3) **Same HMAC shared secret as workers** for v1 (single operator). A
  separate read-only token comes when there are untrusted watchers.

---

## 4 · How this rides the IM × agent matrix

Both surfaces are **agent-kind and IM-agnostic by design**, which keeps the
product matrix (lark/telegram/slack × cc/codex/…) from exploding:

- **Progress protocol is the narrow waist.** Workers emit structured progress
  events; the bridge renders them into whatever IM. A telegram adapter renders
  the *same* events into a telegram message edit; slack into a slack update. One
  progress format, N channels — no per-IM progress logic.
- **Per-agent-kind parsing is isolated.** cc-worker parses Claude's stream-json.
  A future codex-worker parses codex's event format and emits the *same*
  `ProgressBody.event` shape. The bridge + watch TUI never learn a second
  format. (§2.3 OQ-A3 fallback covers agents with no structured stream.)
- **`cc-worker watch` is one TUI for all of it** — it renders progress events
  regardless of which IM dispatched the task or which agent runs it.

So: build the structured progress protocol once (§2), and both "richer lark" and
"local watch" + every future IM/agent inherit it.

---

## 5 · Suggested PR sequencing

```
PR-OBS-1 · structured progress protocol + stream-json parser (Surface 1 core)
  ├── ProgressBody.event field (doorbell types + runner)
  ├── runner.ts: spawn with --output-format stream-json --verbose; JSONL parser
  ├── event → progress descriptor (tool/thinking/text), reuse arg-preview shapes
  ├── cmd-feishu progress hook: render rolling activity log
  ├── progress.showThinking config (default false)
  └── tests: parser fixtures (real stream-json captured), render snapshots

PR-OBS-2 · cc-worker watch TUI (Surface 2)
  ├── doorbell GET /watch SSE endpoint (HMAC, read-only, snapshot-on-connect)
  ├── cc-worker watch client + minimal ANSI renderer + --plain mode
  └── tests: SSE fan-out, renderer line-diff

(both land before telegram so telegram inherits rich progress for free)
```

Sequencing note vs the agreed roadmap (telegram → selector-routing → codex →
slack): PR-OBS-1 ideally lands **before telegram** so the telegram adapter
renders rich progress from day one instead of the stdout-tail stopgap. PR-OBS-2
can land anytime; it's independent.

---

## 6 · Self-review checklist

- [ ] Does stream-json parsing change the worker's result-extraction? (The
      `result` event carries the final text — must map to the existing
      `/mac/result` POST exactly, no behaviour change on the terminal edit.)
- [ ] Lark edit rate limit under event-driven flushing — does a tool-heavy turn
      exceed it? (Coalesce; cap edits/sec.)
- [ ] Thinking leakage: confirm `showThinking` defaults off and elides.
- [ ] `/watch` SSE auth + does it leak task prompts to a read-only watcher who
      shouldn't see them? (Same-operator assumption v1; note it.)
- [ ] Fallback path intact for agents without stream-json (codex later).

## Changelog

- **v1 · 2026-06-14 · mac CC**: initial draft. Two surfaces — richer lark
  progress via `claude -p --output-format stream-json` (PR-OBS-1), and a
  read-only `cc-worker watch` TUI fed by a doorbell `GET /watch` SSE
  (PR-OBS-2). Structured progress protocol is the narrow waist that keeps the
  IM × agent matrix from exploding. Recommends PR-OBS-1 before telegram.
  Awaiting operator review on OQ-A1..3 / OQ-B1..3.

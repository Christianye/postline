# cc-worker — register your CC session as a doorbell worker

`postline cc-worker` turns the directory you're sitting in into a worker that the postline bridge can dispatch IM-routed tasks to. Open Claude Code in your repo as usual; in another terminal (same machine), run `postline cc-worker start` against the bridge's doorbell server and your CC is now reachable from Feishu.

## What it does

1. POSTs `/mac/register` to the bridge with `{cwd, hostname, agentKind, pid}` (`agentKind` defaults to `cc`).
2. Long-polls `/mac/poll` (30s holds, 1s→30s exponential backoff on errors).
3. On 200 task: spawns `claude -p <preamble + prompt> --output-format stream-json --verbose` in the same cwd, parses the structured event stream, and posts a live activity feed to `/mac/progress` (🔧 tool calls, assistant text, `💭` thinking if enabled) — the IM message edits in place. Posts `/mac/result` on exit (final text from the `result` event).
4. Re-registers on 401 unknown_worker. Backs off on 409 standby. Exits cleanly on SIGINT/SIGTERM.

By default the worker surfaces tool calls + assistant text but **not** thinking (it can be long / sensitive). Set `CC_WORKER_SHOW_THINKING=1` in the worker's environment to add a single elided `💭 …` line on thinking. Agents that don't emit `stream-json` fall back to a tail-of-stdout summary.

The headless preamble adds the §PR-DB-3 invariants — same model / system prompt / memory as your interactive CC, plus an instruction to emit `<eta>SECS</eta>` if total runtime is expected to exceed 30s.

## Setup (one-time per machine)

1. Install the postline npm package or have the repo cloned and built:
   ```bash
   cd ~/Downloads/ClaudeCode/postline
   pnpm install && pnpm -r build
   ```
2. Make the `postline` CLI runnable:
   ```bash
   npm link  # in packages/cli, optional; or use `node packages/cli/dist/bin.js`
   ```
3. Set the doorbell-side env on the bridge host (typically EC2). Already documented in `deploy/docker/.env.example` post-PR-DB-1.

## Setup (every time you start)

In a terminal on the host where your CC is running:

```bash
export CC_DOORBELL_URL=http://localhost:9999       # or the SSM-tunneled host
export CC_DOORBELL_SECRET=$(cat ~/.cc-dev/.doorbell-secret)
cd ~/Downloads/ClaudeCode/postline                  # the repo you want @cc-able
postline cc-worker start
```

Leave that terminal open. Closing it (Ctrl-C, terminal close) stops the worker cleanly.

### Worker agent kind — Claude Code (default) or Codex

A worker spawns a headless agent per dispatched task. By default that's Claude Code (`claude -p`). To register a **Codex** worker instead:

```bash
postline cc-worker start --agent codex      # or: CC_WORKER_AGENT_KIND=codex postline cc-worker start
```

A codex worker spawns `codex exec --json` (sandbox `workspace-write`) and maps its event stream to the same progress feed. The worker reports `agentKind: codex` on registration, so once selector routing is on you can target it explicitly with `!pl@codex@<repo>` (vs `!pl@cc@<repo>`). Run a `cc` and a `codex` worker for the same repo to have both available.

## Watching live activity

To see what every in-flight task is doing across the bridge — from any terminal (iTerm2, Wave, a tmux pane) — run a read-only watcher:

```bash
export CC_DOORBELL_URL=http://localhost:9999
export CC_DOORBELL_SECRET=$(cat ~/.cc-dev/.doorbell-secret)
postline cc-worker watch            # redrawing TUI
postline cc-worker watch --plain    # append-only (pipe / scrollback friendly)
```

It subscribes to the doorbell `GET /watch` SSE stream and renders each task's status + latest activity line (🔧 tool calls, 💭 thinking, assistant text) live. Read-only — it never dispatches or approves. This is the local-terminal complement to the in-IM progress feed: the same events, rendered where you're working.

In another terminal, you also need an interactive Claude Code session in the same cwd — `cc-worker` doesn't open one for you; it just dispatches `claude -p` for headless tasks. The interactive CC + the cc-worker are two processes sharing one cwd.

## Subcommands

```text
postline cc-worker start    Foreground; long-polls + handles tasks. Stop with Ctrl-C.
postline cc-worker stop     SIGTERMs the worker recorded for the current cwd + host.
postline cc-worker status   Prints the recorded worker state (pid, doorbellUrl, alive?).
```

## Troubleshooting

- **`register failed: 401`** — `CC_DOORBELL_SECRET` doesn't match the bridge's `cfg.doorbell.secret`.
- **`register failed: 403 ts_skew`** — host clock is out of sync with the bridge by more than 60s. Run `chronyd`/`ntpd` or fix `date`.
- **Worker registers but tasks never arrive** — check the bridge's `routing.md`. The matcher needs a path / repo / verb keyword, OR you need the `!pl@<repo>` override prefix in your Feishu message (`pl` = the configured wake-name; set `## wake` in `routing.md` to change it).
- **`409 status:demoted`** — you started a second `cc-worker start` for the same cwd. The newer one is now active; the older one is in standby. `cc-worker stop` the duplicate to free the slot.
- **`429 queue_full`** — 10 tasks already queued for this cwd. Drain the active worker first.

## Multi-host

You can run `cc-worker start` on both your Mac and your EC2 (via SSM tmux). They register with different `host` strings, so a `!pl@mac@repo` / `!pl@ec2@repo` override (the middle segment is a selector matching host **or** agent-kind) pins which one handles the task. Without an override, the matcher routes to whichever one is currently active for the matched cwd; the latest registration for a given cwd wins.

## Internals

- Pid file: `~/.postline/state/cc-worker-<host>-<cwd-hash>.json` (or `$CC_STATE_DIR/`).
- The CC binary is found via `PATH`; override with the `claudeBin` runner option (programmatic only).
- Long-poll wire protocol: see `docs/designs/doorbell.md` §4.0.

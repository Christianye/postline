# cc-worker — register your CC session as a doorbell worker

`postline cc-worker` turns the directory you're sitting in into a worker that the postline bridge can dispatch IM-routed tasks to. Open Claude Code in your repo as usual; in another terminal (same machine), run `postline cc-worker start` against the bridge's doorbell server and your CC is now reachable from Feishu.

## What it does

1. POSTs `/mac/register` to the bridge with `{cwd, hostname, pid}`.
2. Long-polls `/mac/poll` (30s holds, 1s→30s exponential backoff on errors).
3. On 200 task: spawns `claude -p <preamble + prompt>` in the same cwd, debounces stdout to `/mac/progress` every 5s, posts `/mac/result` on exit.
4. Re-registers on 401 unknown_worker. Backs off on 409 standby. Exits cleanly on SIGINT/SIGTERM.

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

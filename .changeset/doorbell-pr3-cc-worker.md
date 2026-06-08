---
'@postline/cli': minor
---

feat(cc-worker): PR-DB-3 — registers a CC session as a doorbell worker

New `postline cc-worker <start|stop|status>` subcommand. Closes the
loop opened by PR-DB-1 (HTTP server) + PR-DB-2 (router): a Feishu
message that the router decides to dispatch can now actually flow to
a real Claude Code session that runs `claude -p` in the right cwd.

What it does:

- Registers (POST /mac/register) with `{cwd, hostname, pid}`.
- Long-polls (GET /mac/poll) — 200 task / 204 idle / 401 unknown /
  409 standby/demoted. Backoff 1→2→5→10→30s on errors. Re-registers
  on 401.
- On 200 task: spawns `claude -p <preamble + prompt>` in the worker's
  cwd. Headless preamble encodes the §PR-DB-3 invariants (eta tag,
  same model + memory + system prompt as interactive CC).
- Stdout pipe → POST /mac/progress, debounced 5s. Stderr buffered.
- On exit: POST /mac/result with status `ok` / `failed` / `timeout`
  / `killed`.
- Pid file at `~/.postline/state/cc-worker-<host>-<cwd-hash>.json`
  (or `$CC_STATE_DIR/...`). `stop` looks it up + SIGTERMs the pid.
  `status` prints recorded record + alive check.

cwd canonicalisation per design §4.4: git toplevel → realpath →
POSIX-normalise → preserve case. Fully testable: the canonicalize
function takes overrides for git/realpath so unit tests don't need
real git state.

Tests (24 new, 626 in the workspace total):
- canonicalize.test.ts (7): no git → cwd; git override; realpath
  resolution; ENOENT fallback; case preservation; reportingHostname
- state.test.ts (10): round-trip; missing/garbage/invalid records;
  clear idempotent; per-host & per-cwd file isolation; sanitised
  hostnames; isPidAlive against current/dead/invalid pids
- runner.test.ts (7): real server integration — register/poll(idle),
  enqueue+poll(task), demoted poll, unknown worker, wrong secret;
  backoffMs ladder

Operator docs in `docs/cc-worker.md`.

What's still missing (PR-DB-4):
- ETA parser tightening (server-side; right now the runner reads ETA
  from stdout but the server doesn't wire it into Feishu UX yet).
- In-place message-edit progress display.
- `@cc status #taskid` and `@cc workers` builtin tools.

After this merges + a real Feishu app + a real `claude` binary, the
operator can finally @cc from Feishu and watch a task actually run on
their Mac and reply with the result. End-to-end loop closed.

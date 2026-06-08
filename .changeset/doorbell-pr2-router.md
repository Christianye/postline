---
'@postline/core': minor
'@postline/config': minor
'@postline/cli': minor
---

feat(router): PR-DB-2 — routing.md loader + matcher + Feishu dispatch flow

Wires the doorbell from PR-DB-1 into the Feishu inbound path via a
routing.md-driven router (design §8 + reframe §3.2). The bridge now:

1. Loads `routing.md` from `<memory.dir>/routing.md` (or
   `cfg.router.routingMdPath`) on `runFeishu` startup.
2. chokidar-watches the file with atomic-swap reload (D09): edits
   apply on the next inbound message without restart.
3. For each inbound, runs `matchRoute(cfg, ...)` ahead of the local
   turn loop. The decision determines:
   - `dispatch_to_mac` → enqueue a task on the doorbell coordinator;
     reply with `🟡 dispatched to mac` (or `🟠 queued, no worker, will
     be lost if postline restarts` when no active worker for the cwd).
   - `reject_no_worker` → reply with a hint to start a worker or
     enable embedded LLM.
   - `reject_destructive_no_worker` → reply with a refusal explaining
     why; never queue.
   - `ec2_self_solve` / `ec2_direct_answer` → fall through to the
     local turn loop (only useful when `embeddedLlm.enabled = true`).
4. New override prefixes parsed in router: `!cc`, `!cc:<repo>`,
   `!cc:<repo>@<host>`, `!ec2`, `!plain`.

Adds:

- `@postline/core/router` — types, parser, matcher, chokidar loader.
  39 new router tests (8 parser + 25 matcher + 6 loader). chokidar 4.x
  added to @postline/core deps.
- `@postline/config` — new `router` block (routingMdPath /
  reloadDebounceMs) and `embeddedLlm.enabled` toggle (default false,
  per RF1).
- `@postline/cli` — `runFeishu` starts the routing loader, calls
  `matchRoute` before the turn loop, dispatches to the doorbell
  coordinator (PR-DB-1) on `dispatch_to_mac`, sends explicit Feishu
  reply on rejects. Routing loader closes on SIGINT/SIGTERM.

What this enables (visible to the operator):

- @cc-ing a Feishu chat with a `routing.md` rule that hits → the
  bridge replies in the chat with the dispatch / reject status. The
  task itself doesn't yet flow to a real CC because the worker side
  (`cc-worker` skill) lands in PR-DB-3. A mock worker via curl can
  exercise the round-trip today.
- Any edit to `routing.md` takes effect on the next inbound, no
  restart needed.

What's still missing (PR-DB-3 + later):

- A real CC-worker skill that registers, long-polls, runs `claude -p`,
  posts progress + result. PR-DB-3.
- ETA parser, in-place message-edit progress, status / workers
  query. PR-DB-4.
- LLM toggle wiring on the turn loop side. PR-DB-5.

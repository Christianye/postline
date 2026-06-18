---
'@postline/doorbell': patch
'@postline/adapters-cli': patch
'@postline/adapters-slack': patch
---

fix: selector-aware dispatch, retry cap, per-kind keeper, slack dedup + backoff

Five code-audit bugs:

- **Selector-blind dispatch.** A `!pl@codex@repo` task could be grabbed by a
  polling cc worker on the same cwd: the immediate-dispatch path honoured the
  selector but `queue.dispatch` (the pull + requeue paths) did not. The task
  now persists its `selector`, and `dispatch` takes a `canTake` predicate so a
  worker only pulls a selector-targeted task when its agentKind/host matches.
- **retryCount cap never enforced.** `releaseWorker` incremented `retryCount`
  and unshifted the task to the head of its cwd queue forever — a task that
  kept killing workers head-of-lined the queue. It now fails (terminal, fires
  the terminal hook) after `MAX_RETRIES` (2) instead of requeuing.
- **Keeper "one worker per cwd per kind" was per cwd.** `spawned` keyed by cwd
  alone, so a `wake{codex}` while a cc worker ran logged `already_running` and
  the codex task never drained. Now keyed by `(cwd, kind)`.
- **Slack double-delivered channel mentions.** A mention arrives as both a
  `message` and an `app_mention` event (same ts) → two turns / replies /
  approval cards. Added a bounded TTL dedup on the stable inbound id.
- **Slack socket reconnect hot-looped after a post-open close.** Backoff only
  applied on connect failure; an opened-then-closed socket reconnected with no
  delay (reconnect storm / rate-limit risk). Now backs off on a bare `close`
  (graceful `disconnect` still reopens immediately).

+15 tests.

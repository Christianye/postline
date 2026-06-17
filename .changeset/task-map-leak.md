---
'@postline/doorbell': patch
'@postline/adapters-slack': patch
---

fix(doorbell): prune terminal tasks so the queue's task map stays bounded

The queue's `tasks` map never deleted a task once it reached a terminal
status (`done` / `failed` / `timeout`). The FIFO `byCwd` list dropped it at
dispatch, but the source-of-truth map kept it forever — so a long-running
(resident) bridge grew the map without bound, and every O(n) scan over it
(`busyWorkerIds`, `getByFeishuMessageId`, `snapshotInFlight`) slowed down
with each task ever run.

- `Task.terminatedAt` is stamped on the first transition to a terminal
  status (re-posts keep the original timestamp).
- `TaskQueue.sweepTerminal(now, retentionMs)` prunes tasks that have been
  terminal longer than the retention window, scrubbing `byCwd` too.
- The coordinator's existing heartbeat-sweep timer now also calls it;
  `CoordinatorOptions.terminalRetentionMs` (default 60s) keeps late
  duplicate result posts + the terminal hook working before pruning.

Also: the slack adapter set `isBot: false` unconditionally — harmless
(bot messages are already dropped earlier by `bot_id`) but now reports
`!!ev.bot_id` honestly, matching telegram/feishu semantics.

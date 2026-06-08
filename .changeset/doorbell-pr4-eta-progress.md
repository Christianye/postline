---
'@postline/doorbell': minor
'@postline/cli': minor
---

feat(doorbell): PR-DB-4 — ETA validation + Feishu progress edits + status / workers

Closes the IM UX gap left by PR-DB-1..3:

- Server-side ETA validation: numeric, > 0, ≤ 3600s. Otherwise dropped
  silently. Per design F14.
- Coordinator hooks `onTaskProgress` / `onTaskTerminal` fire on
  /mac/progress and /mac/result respectively. cmd-feishu subscribes
  these and uses `channel.editText(seedMessageId, …)` to mutate the
  same Feishu message that announced the dispatch.
- Progress edits debounced 5s per task per Feishu rate-limit guard.
- Terminal edit: 🟢 #id done + body / 🔴 #id timeout / 🔴 #id failed
  + errorMessage. 4500-char clip at end.
- Seed-message capture: dispatch path now uses `channel.sendText`
  (which returns msgId) instead of `channel.send`, then stashes the
  msgId on the task so the hooks can find it.
- New builtin queries handled by the bridge before the router runs:
  - `@cc workers` → registry snapshot, per-cwd active + standby
    listing with last-poll age.
  - `@cc status #a3f8` → recorded task state (status / cwd / owner /
    retries / timestamps / feishu msg id).

Tests: 8 new in @postline/doorbell `progress.test.ts` covering ETA
validation (>3600 / ≤0 / non-numeric / valid), terminal status mapping
(ok→done / failed / timeout), hook-error tolerance. Workspace 641 / 0.

The IM round-trip from PR-DB-3 now arrives back as live, edited
progress instead of just a one-shot 🟡 line. Tasks that take >5s
update the user as they go; the final result replaces the seed.

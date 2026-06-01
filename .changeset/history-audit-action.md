---
'@postline/tools-builtin': patch
---

Add `history_audit` action to `postline_stats`. Operators can ask the bot "run postline_stats action=history_audit" to dry-run the orphan-detection logic across every conversation jsonl on disk and surface the chats with the most orphan rows. No mutation — pure inspection.

Output ranks the top N (default 5, capped at 50) files by orphan count plus per-file breakdown of `orphan_tool_use` vs `standalone_tool` rows and corrupt JSONL lines. Useful for spotting which conversations had aborted turns historically (the rows the load-side `sanitizeHistory` pass would drop).

Wiring is opt-in via a new `historyAuditFn` callback on `PostlineStatsOptions` (kept abstract so this package stays decoupled from any filesystem adapter). The CLI host injects `auditHistoryDir(historyDir)` from `@postline/cli` when `cfg.history.kind === 'fs'`.

Helpers added in `@postline/cli`:

- `auditHistoryMessages(msgs)` — count-only orphan detection mirroring the classification used by `sanitizeHistory`
- `auditHistoryDir(dir)` — directory walk returning per-file `HistoryFileAudit` rows + aggregate totals

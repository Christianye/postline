---
'@postline/adapters-feishu': patch
---

Approval-card preview is now rendered per tool instead of as a single JSON blob:

- `bash` / `bash_read` → command in a `bash` fenced code block; cwd and timeout as inline footnotes
- `fs_write` → path inline + content size + content snippet (fenced)
- `fs_edit` → path inline + old_string + new_string (each clamped to 200 chars)
- `fs_read` → path inline
- `web_fetch` → URL inline + optional Accept header
- `feishu_send` → target chat_id + message text + mentions list
- `gh_query` / `gh_action` → `gh ...` reconstructed in a `bash` fenced block
- `skill_run` → skill id + script path + JSON-quoted argv + timeout
- unknown tool name → fenced JSON fallback (covers MCP-spawned tools)

Truncation is per-field with an explicit `[…N chars truncated]` suffix instead of the old silent `…` ellipsis, so reviewers can see when input was cut.

**Breaking API change** (within `@postline/adapters-feishu`): `ApprovalCardParams.argsPreview: string` is replaced by `args: Record<string, unknown>` — the formatter renders inside `buildApprovalCard`. The only in-tree caller (`@postline/cli` / cmd-feishu) is updated; downstream consumers calling `buildApprovalCard` directly need to swap the field. Pre-1.0 patch bump per the workspace versioning policy.

New export: `formatToolArgsPreview(toolName, args): { fields: PreviewField[] }` for reuse outside the card builder.

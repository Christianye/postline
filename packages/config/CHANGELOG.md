# @postline/config

## 0.2.0

### Minor Changes

- f254229: Restrict approval-card and `/approve` `/deny` slash-command resolution to the user who originally triggered the dangerous tool, with an optional admin-override list. Default is `requesterOnly: true` (a behaviour change in shared chats: bystanders who could previously approve any dangerous action on behalf of someone else now cannot).

  New `feishu.approval` config block:

  ```ts
  feishu: {
    approval: {
      requesterOnly: true,            // default — set false for legacy behaviour
      admins: ['ou_oncall_human'],    // override list, default []
    },
  }
  ```

  Behaviour:

  - `requesterOnly: true` + clicker is the original requester → allow
  - `requesterOnly: true` + clicker is in `admins` → allow + audit-log `feishu_approval_override` with `{actionId, requester, override_by, tool}`
  - `requesterOnly: true` + neither → toast `"Only the requester (or an admin) can resolve this action."`, audit-log `feishu_approval_rejected_not_requester`
  - `requesterOnly: false` → any allowlist member can resolve (legacy behaviour)

  Both card-button clicks and the `/approve <id>` / `/deny <id>` text fallback go through the same authorization function so the gate cannot be bypassed by typing the slash command.

  Validation: `feishu.approval.admins` must be an array of non-empty open_id strings.

### Patch Changes

- Updated dependencies [d7dadb1]
- Updated dependencies [377b80b]
- Updated dependencies [fcb8351]
  - @postline/core@0.2.0
  - @postline/providers@0.2.0
  - @postline/mcp-client@0.1.11
  - @postline/skill-loader@0.1.11

## 0.1.10

### Patch Changes

- Two fixes shipped together as 0.1.10:

  - **Prevent orphan `tool_use` blocks from poisoning conversation history.** When a stream errored or hit `max_tokens` after the assistant emitted a `tool_use` block, the turn loop persisted the assistant message but no matching `tool_result`, so subsequent turns reloaded a malformed `messages[0]` and the Anthropic API rejected with `Expected toolResult blocks at messages.0.content for the following Ids`. `@postline/core` now injects a synthetic `isError` `tool_result` on abort, and `@postline/cli` adds a `sanitizeHistory` pass on `load()` that drops orphan rows already on disk so existing polluted jsonl files heal automatically. (#1)
  - **Inline-swap the approval card on click.** Clicking Approve or Deny on a dangerous-tool approval card now atomically replaces the card with a resolved-state variant (green ✅ "Approved" / grey ❌ "Denied", no buttons, signed by clicker + timestamp). `buildApprovalCard` now sets `config.update_multi: true` (required for inline replacement), `CardActionResponse` gains an optional `card?: { type: 'raw'; data }` field, `buildResolvedCard` is newly exported from `@postline/adapters-feishu`, and `PendingActions` gains a `get(id)` accessor so adapters can read entry metadata before resolving. (#2)

- Updated dependencies
  - @postline/core@0.1.10
  - @postline/mcp-client@0.1.10
  - @postline/providers@0.1.10
  - @postline/skill-loader@0.1.10

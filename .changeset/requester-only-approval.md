---
'@postline/config': patch
---

Restrict approval-card and `/approve` `/deny` slash-command resolution to the user who originally triggered the dangerous tool, with an optional admin-override list. Default is `requesterOnly: true` (a behaviour change in shared chats: bystanders who could previously approve any dangerous action on behalf of someone else now cannot).

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

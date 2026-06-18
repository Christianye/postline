---
'@postline/doorbell': patch
'@postline/tools-builtin': patch
'@postline/config': minor
'@postline/cli': patch
---

fix: clear the audit backlog (approval authz, terminal guard, body cap, fs realpath, poll cleanup)

The remaining major/minor findings from the health-check audit:

- **Telegram/Slack approval lacked `requesterOnly`.** Both gated the base
  allowlist but let any allowlisted user approve another user's dangerous
  tool. A shared `authorizeApproval` (in `im-bridge`) now enforces the same
  requester-only rule Feishu has, with an admin override; configurable via
  `telegram.approval` / `slack.approval` (`requesterOnly` default true).
- **Terminal status was not absorbing.** A late `running` progress post that
  raced the result could flip a `done`/`failed`/`timeout` task back to
  `running`, re-adding it to in-flight snapshots and re-exempting a dead
  worker from the sweep. `updateStatus` now rejects any transition out of a
  terminal state.
- **Doorbell buffered request bodies with no size cap (pre-auth).** An
  unauthenticated caller could exhaust memory. Bodies over 1 MB now get a
  413 before HMAC verification.
- **`fs_write` / `fs_edit` containment was textual.** A symlink under a
  writable root pointing outside it escaped the allowlist. Containment now
  realpaths the deepest existing ancestor (and the allow-roots, since a root
  may itself be a symlink like macOS `/tmp`) and requires the real target to
  stay within. Also adds the missing empty-path guard to `fs_edit`.
- **Superseded long-polls dangled.** When a worker opened a fresh poll while
  an old one was parked, the old HTTP response sat open until its ~30s
  timeout. The coordinator now signals `onSuperseded` so the server closes
  it 204 immediately.

+6 tests. Closes the audit backlog (the health-check is now fully resolved).

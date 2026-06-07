---
'@postline/core': minor
'@postline/adapters-feishu': minor
'@postline/config': minor
'@postline/cli': minor
---

feat(notify): design-review push poller (PR-DB-0)

Bridge-side proactive notification. When `notify.designReviewPush` is
configured with `enabled: true`, the feishu daemon spawns a background
poller that watches a GitHub repo for new comments on PRs touching
`docs/designs/*.md` (configurable). On every fresh comment, postline
DMs the operator with a one-line summary that includes the PR title,
author, snippet of the comment, and a link.

Why this matters in the reframed bridge: the operator no longer has to
refresh GitHub manually to see whether design-doc reviews have arrived.
Each push is deduped per `(PR, comment_id)` via a state file at
`~/.postline/state/design-review-pushed.json` (or
`$CC_STATE_DIR/...`).

New exports:
- `@postline/core`: `startDesignReviewPushPoller`, `isDesignReviewPr`,
  `formatPushMessage`; types `DesignReviewPushOptions`,
  `DesignReviewPushHandle`.
- `@postline/adapters-feishu`: `FeishuChannel.sendDirectMessage(...)`
  for DM-by-open_id (used by the poller, also generally useful).
- `@postline/config`: `notify.designReviewPush` block.

The poller serializes ticks (kickoff + interval cannot overlap, so a
slow `gh` call doesn't double-push). Errors during a tick are logged
and the timer continues. `gh` is invoked through a swappable `ghJson`
hook (default spawns from PATH), keeping tests offline.

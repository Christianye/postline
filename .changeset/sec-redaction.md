---
'@postline/core': patch
'@postline/adapters-cli': patch
---

fix(security): redact secrets on the worker→bridge→IM path + add missing key patterns

The redactor was missing the key types most likely to be present on a
worker host, and the doorbell/worker path never redacted at all — raw tool
output and final answers were POSTed and edited into the IM verbatim.

Redactor (`@postline/core` `redact`):
- Added patterns: `sk-ant-…` (Anthropic), `sk-…`/`sk-proj-…` (OpenAI),
  `xoxb-`/`xoxp-`/`xapp-`/… (Slack), `github_pat_…` (fine-grained GitHub —
  the old `gh[pousr]_` regex literally could not match it).
- AWS access-key id is now case-insensitive.
- AWS secret-access-key now matches when the keyword precedes the value
  (`aws_secret_access_key = <40-char>`), which the old forward-only
  lookahead missed — without over-redacting a bare 40-char git sha.

Worker + bridge wiring:
- `cc-worker` runner now redacts every free-text field (summary, event
  label, result text, errorMessage) at the POST boundary before it leaves
  the worker.
- The IM bridge redacts again on its side (defense in depth — an older
  worker may not redact) before `editText`.
- Live-typing stream hooks (`onTextDelta`/`onThinkingDelta`) redact the
  `accumulated` text the UI renders, so a secret emitted mid-stream is
  masked as soon as the full pattern is present, not only in the final
  message.

+9 tests (redactor patterns, worker-side POST redaction).

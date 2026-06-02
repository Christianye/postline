---
'@postline/providers': patch
---

Bump `@anthropic-ai/sdk` from `^0.40.0` to `^0.100.1`. Removes the `unknown` cast workaround in the anthropic provider's adaptive-thinking request — the SDK now natively types `thinking.type: 'adaptive'` and `output_config.effort`, so the provider passes through cleanly.

Internal-only change. No public-facing API surface affected; tests still 446/446. The SDK's stream-event shape (`message_start` / `content_block_start` / `content_block_delta` / `content_block_stop` / `message_delta` / `message_stop`) is unchanged across the version range, so the existing event handling in `streamOne` works untouched.

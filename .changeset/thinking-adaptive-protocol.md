---
'@postline/config': patch
'@postline/core': patch
'@postline/providers': patch
---

Fix extended-thinking protocol: switch from the old `thinking.type='enabled'` + `budget_tokens` shape to the new `thinking.type='adaptive'` + `output_config.effort` shape required by Claude Opus 4.7+.

Background: PR #12 shipped extended-thinking using the manual-budget protocol, which Bedrock rejected on Opus 4.7 with `"thinking.type.enabled" is not supported for this model. Use "thinking.type.adaptive" and "output_config.effort"`. The model also fell through the entire fallback chain (sonnet-4-6, opus-4-6, haiku-4-5) returning the same error, so any turn with thinking enabled failed silently with `replyLen: 0`. Fix verified against the [Bedrock adaptive thinking docs](https://docs.aws.amazon.com/bedrock/latest/userguide/claude-messages-adaptive-thinking.html) and the Anthropic SDK `ThinkingConfigAdaptive` / `OutputConfig` types.

API changes (all packages still pre-1.0, so patch):

- `@postline/config` `inference.thinking`: `budgetTokens?: number` → `effort?: 'low' | 'medium' | 'high' | 'max'`. Default `'high'` (always think). Manual budget knob is gone — adaptive mode lets the model decide.
- `@postline/core` `TurnRequest.thinking` and `TurnLoopConfig.thinking`: same shape change.
- `@postline/providers` bedrock: sends `additionalModelRequestFields: { thinking: { type: 'adaptive' }, output_config: { effort } }` (effort is rejected if placed inside `thinking` — Bedrock requires it in a sibling `output_config`).
- `@postline/providers` anthropic: top-level `thinking: { type: 'adaptive' }` + top-level `output_config: { effort }`. The installed `@anthropic-ai/sdk@^0.40.0` types still only know `'enabled' | 'disabled'`, so the field is cast through unknown until a future SDK bump.

Both providers continue to surface thinking deltas as `'thinking_delta'` `StreamChunk`s; nothing on the consumer side (turn loop, feishu-stream) changes.

# @postline/config

## 0.3.0

### Minor Changes

- 02aaa89: Add opt-in extended-thinking (reasoning) support across providers, the turn loop, and the Feishu streaming surface. When enabled, the model emits a thinking block before its visible answer; postline streams thinking deltas live to the seed message but does NOT persist them — each turn's reasoning is independent (no signature roundtrip overhead, simpler multi-turn semantics).

  ## Config

  ```ts
  inference: {
    thinking: {
      enabled: true,
      budgetTokens: 4096,   // default 4096, min 1024
    },
  }
  ```

  Off by default. Costs `budgetTokens` of additional output budget per turn (in addition to `maxTokens`).

  ## Wiring

  - `@postline/core`: new `'thinking_delta'` `StreamChunk` variant carrying a `thinking` text field; new `TurnLoopConfig.onThinkingDelta` hook (mirrors `onTextDelta` shape — `{delta, accumulated, iter}`); new `TurnRequest.thinking` request field; `collectStream` accumulates thinking text per-iter (separate from assistant text) and forwards deltas to the hook.
  - `@postline/providers` (anthropic): passes `thinking: {type: 'enabled', budget_tokens}` to `messages.stream`; surfaces `content_block_delta` events with `delta.type === 'thinking_delta'` as `'thinking_delta'` chunks. `signature_delta` and other delta kinds are dropped (scope (c) doesn't echo thinking back in multi-turn).
  - `@postline/providers` (bedrock): passes `additionalModelRequestFields.thinking` (Bedrock Converse doesn't have a first-class thinking field); decodes `reasoningContent` deltas — only the `text` member is forwarded; `signature` / `redactedContent` members are ignored.
  - `@postline/adapters-feishu` `feishu-stream` (CLI): new `onThinkingDelta(accumulated)` method on `StreamingHandle`. Renders a rolling placeholder `💭 <last 200 chars>` in the seed message during silent windows; same gate as status events — once real assistant text streams in this iter, thinking is ignored. Whitespace is collapsed so the placeholder stays single-line. The CLI host wires `streamer.onThinkingDelta` from the new turn hook.

  ## Why "scope (c)"

  Per the design exploration, three options were considered:

  - (a) full roundtrip — keep thinking blocks + signatures in history so multi-turn reasoning chains are preserved (Anthropic's recommended pattern). Adds protocol complexity for minimal value in postline's single-turn-per-message use case.
  - (b) lite — count thinking tokens only, no UI visibility. Loses the debug value of seeing what the model is reasoning about.
  - (c) **chosen** — show thinking text live, drop on history boundary. Each turn's reasoning is independent; the user sees `💭 …` rolling text during silent windows, then the answer; the next turn starts fresh without any signature roundtrip overhead.

  ## Test plan

  8 new unit tests:

  - core: thinking_delta forwarded to hook with correct accumulated text; thinking does NOT enter persisted history; hook errors don't crash the turn
  - feishu-stream: 💭 prefix + rolling 200-char window + whitespace collapse; pre-text gate suppression; finish() override

### Patch Changes

- e8e1264: Fix extended-thinking protocol: switch from the old `thinking.type='enabled'` + `budget_tokens` shape to the new `thinking.type='adaptive'` + `output_config.effort` shape required by Claude Opus 4.7+.

  Background: PR #12 shipped extended-thinking using the manual-budget protocol, which Bedrock rejected on Opus 4.7 with `"thinking.type.enabled" is not supported for this model. Use "thinking.type.adaptive" and "output_config.effort"`. The model also fell through the entire fallback chain (sonnet-4-6, opus-4-6, haiku-4-5) returning the same error, so any turn with thinking enabled failed silently with `replyLen: 0`. Fix verified against the [Bedrock adaptive thinking docs](https://docs.aws.amazon.com/bedrock/latest/userguide/claude-messages-adaptive-thinking.html) and the Anthropic SDK `ThinkingConfigAdaptive` / `OutputConfig` types.

  API changes (all packages still pre-1.0, so patch):

  - `@postline/config` `inference.thinking`: `budgetTokens?: number` → `effort?: 'low' | 'medium' | 'high' | 'max'`. Default `'high'` (always think). Manual budget knob is gone — adaptive mode lets the model decide.
  - `@postline/core` `TurnRequest.thinking` and `TurnLoopConfig.thinking`: same shape change.
  - `@postline/providers` bedrock: sends `additionalModelRequestFields: { thinking: { type: 'adaptive' }, output_config: { effort } }` (effort is rejected if placed inside `thinking` — Bedrock requires it in a sibling `output_config`).
  - `@postline/providers` anthropic: top-level `thinking: { type: 'adaptive' }` + top-level `output_config: { effort }`. The installed `@anthropic-ai/sdk@^0.40.0` types still only know `'enabled' | 'disabled'`, so the field is cast through unknown until a future SDK bump.

  Both providers continue to surface thinking deltas as `'thinking_delta'` `StreamChunk`s; nothing on the consumer side (turn loop, feishu-stream) changes.

- Updated dependencies [02aaa89]
- Updated dependencies [e8e1264]
  - @postline/core@0.3.0
  - @postline/providers@0.3.0
  - @postline/mcp-client@0.2.1
  - @postline/skill-loader@0.2.1

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

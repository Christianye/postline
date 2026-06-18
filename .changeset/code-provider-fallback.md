---
'@postline/providers': patch
---

fix(providers): no content duplication on mid-stream fallback

Both providers drove their model fallback chain with `yield*
this.streamOne(...)` inside a try/catch. `withRetry` guarded the HTTP send,
but once `streamOne` started yielding deltas a mid-stream throw still fell
through to the next model — which re-emitted the whole response, so the
consumer saw the truncated first attempt **plus** the complete second one
(duplicated text + tool_use).

Both providers now delegate to a shared `runModelChain` with at-most-once
content semantics: a failure is only retried on the next model if it
happened BEFORE the first content-bearing chunk (`text_delta` /
`thinking_delta` / `tool_use_*`). A mid-stream failure after content is
terminal — it emits `error` + `done` instead of re-running. This also
de-duplicates the (previously identical) fallback loops in the bedrock and
anthropic providers.

+5 tests (isContentChunk + runModelChain fall-before-content / no-fallback-
after-content / all-failed).

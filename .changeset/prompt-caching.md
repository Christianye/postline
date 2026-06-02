---
'@postline/core': minor
'@postline/providers': minor
---

Add prompt caching breakpoints to the system prompt and tool array. Both Bedrock (`cachePoint: {type: 'default'}`) and Anthropic (`cache_control: {type: 'ephemeral'}`) now cache the stable prefix of every request, so subsequent turns within the cache window pay ~10% of the input-token cost on the cached portion.

**Pre-1.0 API change** (minor):

- `TurnRequest.system` was `string`, now `readonly SystemSegment[]` where `SystemSegment = { text: string; cacheable?: boolean }`. Cacheable segments end a cache breakpoint at that position. The host (`@postline/core`'s `runTurn`) builds the segments — out-of-tree consumers calling provider `stream()` directly need to migrate from `system: 'foo'` to `system: [{ text: 'foo' }]`.

Default postline cache layout from `runTurn`:

1. Stable system block (`SYSTEM_PROMPT_BASE` + skill/runtime suffix) → `cacheable: true` → cache breakpoint after.
2. Memory block (`=== MEMORY ===` + memory text) → not cacheable (changes when `memory_write` fires).
3. Tool specs → all-or-nothing cache via a single breakpoint at end (handled in providers, not turn).

Both providers were updated to translate the segments into their native cache-marker shape:

- **Bedrock Converse**: emits `system: [{text}, {cachePoint:{type:'default'}}, {text}]` and appends a `{cachePoint:{type:'default'}}` element after the tool array when at least one tool is present.
- **Anthropic Messages**: emits `system: [{type:'text', text, cache_control:{type:'ephemeral'}?}, ...]` and adds `cache_control:{type:'ephemeral'}` to the LAST tool spec (Anthropic semantics: cache_control on tool N caches everything up to and including tool N).

The `usage` chunks already surface `cacheReadTokens` and `cacheCreationTokens` — `postline_stats action='usage'` will start showing the cache split once turns run with this build.

14 new unit tests cover both providers' segment+tool conversion, including all-cacheable, none-cacheable, empty-text-skip, and last-tool-only cache-control invariants.

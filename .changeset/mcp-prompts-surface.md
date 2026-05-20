---
'@postline/mcp-client': patch
'@postline/adapters-cli': patch
'@postline/adapters-feishu': patch
'@postline/config': patch
'@postline/core': patch
'@postline/providers': patch
'@postline/skill-loader': patch
'@postline/tools-builtin': patch
---

**MCP prompts surface** — when a server advertises the `prompts` capability in its handshake, postline now registers two extra tools automatically:

- `mcp_<server>_prompts_list` (risk=`read`) — enumerate prompts; optional `cursor` for pagination, truncates to 100/page with a `nextCursor` hint. Each line shows the prompt `name`, optional description, and required argument names (marked with `*`).
- `mcp_<server>_prompts_get` (risk=`read`) — render one prompt by `name` with an optional `arguments` object; values are coerced to strings. Returns a `<role>: <text>` transcript prepended with the prompt's description when present. Non-text content parts render as `[unsupported content type: <mime>]` markers.

Both skip the `/approve` gate — fetching a prompt is metadata-shaped and produces no side effects. Capability-gated off the MCP handshake; servers that don't advertise `prompts` are unaffected. Sibling to the `resources` surface shipped in 0.1.7.

Slash-command UX (`/prompts`, `/prompt <server>/<name>`) for prompts triggered by the user directly is still on the roadmap.

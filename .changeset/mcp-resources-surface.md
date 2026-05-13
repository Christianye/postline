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

**MCP resources surface** — when a server advertises the `resources` capability in its handshake, postline now registers two extra tools automatically:

- `mcp_<server>_resources_list` (risk=`read`) — enumerate resources; optional `cursor` for pagination, truncates to 100/page with a `nextCursor` hint
- `mcp_<server>_resources_read` (risk=`read`) — fetch one resource by `uri`; non-text content parts (blob/image) render as `[unsupported content type: <mime>]` markers

No config knob needed; capability-gated off the MCP handshake. Existing servers that only expose `tools` are unaffected. `McpHealth` gains `hasResources` / `hasPrompts` flags for `postline doctor` output.

Next patch ships `prompts` as slash commands.

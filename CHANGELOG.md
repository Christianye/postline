# Changelog

All notable changes to postline are recorded here. Format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow [SemVer](https://semver.org/).

Per-package changelogs live under `packages/*/CHANGELOG.md` once [changesets](https://github.com/changesets/changesets) starts writing to them. This top-level file tracks repo-wide releases.

## [0.1.8] — 2026-05-20

Second half of the P2b "resources and prompts" roadmap item. 0.1.7 surfaced resources; this surfaces prompts. All ten workspace packages bump together.

### Added

- **MCP prompts surface** — when an MCP server advertises the `prompts` capability in its handshake, postline now registers two synthetic tools per server automatically: `mcp_<server>_prompts_list` (risk=`read`, optional `cursor` for pagination, truncates to 100/page with a `nextCursor` hint; each line shows the prompt name, optional description, and required argument names suffixed with `*`) and `mcp_<server>_prompts_get` (risk=`read`, `name` required, optional `arguments` object with values coerced to strings; returns a `<role>: <text>` transcript prepended with the prompt's description when present, non-text parts render as `[unsupported content type: <mime>]` markers). Both skip the `/approve` gate — fetching a prompt produces metadata-shaped messages and performs no side effects. Capability-gated off the MCP handshake; servers that don't advertise prompts are unaffected.
- **`McpClientHandle.listPrompts` / `getPrompt`** — sibling accessors to the resources methods added in 0.1.7. New types `McpPrompt`, `McpPromptArgument`, `ListPromptsResult`, `GetPromptResult`.

### Deferred

- Slash-command UX (`/prompts` list, `/prompt <server>/<name>` invoke) for prompts triggered directly by the user — model-discoverable tools land first; user-typed slash commands require turn-loop hooks and ship later.
- MCP OAuth + WebSocket transports (still on the roadmap; stdio / HTTP+SSE remain the supported set).

[0.1.8]: https://github.com/Christianye/postline/releases/tag/v0.1.8

## [0.1.7] — 2026-05-13

First half of the P2b "resources and prompts" roadmap item. All ten workspace packages bump together.

### Added

- **MCP resources surface** — when an MCP server advertises the `resources` capability in its handshake, postline now registers two synthetic tools per server automatically: `mcp_<server>_resources_list` (risk=`read`, optional `cursor` for pagination, truncates to 100/page with a `nextCursor` hint) and `mcp_<server>_resources_read` (risk=`read`, `uri` required, non-text parts render as `[unsupported content type: <mime>]` markers). Both skip the `/approve` gate — MCP resources are always safe to read. Capability-gating is authoritative: servers that only expose `tools` are unaffected, and `tools/list` is also now gated, so a prompts-only server no longer errors out.
- **`McpHealth.hasResources` / `hasPrompts`** — surfaced for `postline doctor`-style introspection.

### Deferred

- MCP `prompts` surface — coming in 0.1.8 as slash commands (`/prompts` list, `/prompt <server>/<name>` invoke).
- Resource change notifications / subscribe — current version is pull-only.

[0.1.7]: https://github.com/Christianye/postline/releases/tag/v0.1.7

## [0.1.6] — 2026-05-12

Symmetry patch: history is now searchable the same way memory already is. All ten workspace packages bump together.

### Added

- **`history_search` tool** — grep across persisted conversation history (every `*.jsonl` file in `cfg.history.dir`). Literal-default, regex opt-in, case-insensitive, `max_hits` cap, optional `hours` window via file mtime. Symmetric with `memory_search`. Returns conversation hash + role + snippet around the match; extracts text from `text` / `tool_use` / `tool_result` content parts. Registry fails loudly if `history_search` is enabled without `cfg.history = { kind: 'fs', dir }`. 14 new tests.

[0.1.6]: https://github.com/Christianye/postline/releases/tag/v0.1.6

A self-reflection tool so the bot can answer *"how much did I cost this morning?"* and *"are you healthy?"* inside the chat. All ten workspace packages bump together.

### Added

- **`postline_stats` tool (bot self-reflection)** — a single `read` tool with two actions. `action: 'usage'` aggregates token + USD usage from the last N hours (default 24) so the model can answer *"how much did I cost this morning?"*. `action: 'health'` reports uptime, memory dir state (git clean/dirty), history conversation count, usage-log size, and pending-approval count so the bot can self-report status to the chat. 10 new tests covering window filtering, unknown-model USD handling, corrupt-line tolerance, and live pending counts. Enabled per deployment by adding `'postline_stats'` to `tools.builtin` in `postline.config.ts`.
- **`ToolBuildContext` gains `historyDir` / `usageDir` / `pendingCountFn` / `processStartedAtMs`** — plumbed by `cmd-chat`, `cmd-feishu`, `cmd-ask` so tools like `postline_stats` get the data they need without reaching into global state.

[0.1.5]: https://github.com/Christianye/postline/releases/tag/v0.1.5

Live-typing in Feishu, a new PR-review cookbook recipe, and a handful of surface-polish items. All ten workspace packages bump together.

### Added

- **Feishu streaming output (live typing)** — opt in with `feishu.streaming: true`. The bot sends a seed message on the first text delta and edits it in place via `im.v1.message.update`, debounced (default 250ms, configurable via `feishu.streamingDebounceMs`) to stay well under Feishu rate limits. Text longer than 4500 chars spills over into follow-up messages; any edit failure falls open to the standard one-shot send. 10 new tests covering seed, debounce, overflow, failure fallback, redundancy skip, and no-delta turns.
- **`onTextDelta` hook on `runTurn`** — `@postline/core` now surfaces per-chunk deltas (with accumulated text + iteration index) so channel adapters can implement live UIs without peeking into the turn loop.
- **`FeishuChannel.sendText` + `editText`** — expose the feishu SDK's `im.v1.message.create`/`update` in a channel-native wrapper. Used by streaming; available to any future recipe that needs to post + edit.
- **COOKBOOK #11: PR diff review** — paste a `main..HEAD` diff request and the bot runs `skill_review` + `bash_read` (`git diff / show / log` are already allowlist-safe, no code change needed) to produce a checklist-style review. README quickstart mentions the new recipe count (11).

[0.1.4]: https://github.com/Christianye/postline/releases/tag/v0.1.4

Three "match what we claim" additions: conversations survive restart, every turn reports tokens + cost, and dangerous-tool approval becomes a button instead of a text command. All ten workspace packages bump together.

### Added

- **Filesystem-backed conversation history** — new `@postline/cli` history-fs store. Opt in with `cfg.history = { kind: 'fs', dir: '...' }`. Each conversation becomes a JSONL file (md5-hashed id for safe filenames), appended per turn. `systemctl restart cc` no longer wipes in-flight context. 12 tests.
- **Per-turn token + cost tracking** — `StreamChunk.usage` populated by both bedrock and anthropic providers (input / output / cache-read / cache-creation tokens). Pricing table in `@postline/core/pricing.ts` covers Claude 4 + 3.5 families with longest-prefix match. New `UsageRecorder` interface + optional `TurnDeps.usageRecorder`; opt-in JSONL persistence via `cfg.usage = { kind: 'fs', dir: '...' }`. 11 pricing tests.
- **`postline stats` subcommand** — aggregate `usage.jsonl` into a per-model table: calls, input/output tokens, cache R/W, estimated USD. Unknown models render as `?` rather than silent `$0`. `--json` for jq.
- **Feishu interactive approval card** — `dangerous` tool approval now posts an interactive message card with Approve (primary) / Deny (danger) buttons and a red header. Clicks fire `card.action.trigger`; the adapter validates the clicker against the open_id allowlist and returns a toast. Text `/approve <id>` and `/deny <id>` remain as fallbacks (unchanged semantics) for when the `card.action.trigger` event isn't subscribed or the card send fails. 5 card-builder tests.

### Fixed

- `postline --version` now reports the current package version.

[0.1.3]: https://github.com/Christianye/postline/releases/tag/v0.1.3

Sharpens the three ecosystem bridges (memory / skills / MCP) with a search tool, a `tools` listing subcommand, and HTTP/SSE support for remote MCP servers. All ten workspace packages bump together.

### Added

- **`memory_search` tool** — fourth memory op alongside `list`/`read`/`write`. Literal or regex grep across the memory dir, case-insensitive by default, line-anchored output with a `max_hits` cap. Scales to a few hundred files; intentionally not an embedding index. 11 new tests.
- **`postline tools` subcommand** — list every tool the turn runner would receive (builtin + MCP + skills) with `NAME / RISK / SOURCE` columns. `--json` for jq. Useful for screenshots and "what does the model actually see?" debugging.
- **MCP HTTP + SSE transports** — in addition to stdio, `type: 'http'` (aliased `'streamable-http'`) and `type: 'sse'` server configs. Auth is request-header based (`headers: { Authorization: 'Bearer ...' }`); full OAuth flow deferred. Remote MCP servers (Notion, Linear, etc.) plug straight in. 4 new config-loader tests.
- `postline doctor` distinguishes stdio (PATH-checked) from remote HTTP/SSE servers (not network-checked by design).

### Fixed

- Env-fallback loader default memory dir: `~/.cc/memory` → `~/.postline/memory` (brand alignment; `CC_MEMORY_DIR` still honoured for Phase 1 ops).
- README badge + "`pnpm test`" echo updated from 168 → 221 tests.
- `postline --version` reports current package version instead of a hardcoded `0.1.0`.
- `postline.config.example.ts` comment clarity improvements (MCP / skills blocks, empty-config semantics).

[0.1.2]: https://github.com/Christianye/postline/releases/tag/v0.1.2

## [0.1.1] — 2026-05-12

Ecosystem bridges: MCP client and Claude Code skill loader. Both read the same configs Claude Code / Claude Desktop write, so zero duplication for users who already live in that tooling. All ten workspace packages bump together.

### Added

- **MCP (Model Context Protocol) client** — new `@postline/mcp-client` package. Spawns stdio MCP servers declared in `~/.claude.json → mcpServers` and/or inline under `postline.config.ts → tools.mcp`, lists their tools, and exposes each as `mcp_<server>_<tool>` to the turn runner. Default risk tier `dangerous`; per-tool overrides supported. Fail-open on individual server failures, strict mode opt-in. 22 new tests.
- **Claude Code skill loader** — new `@postline/skill-loader` package. Walks `~/.claude/skills/<name>/SKILL.md`, parses frontmatter (`name` / `description` / `disable-model-invocation`), and exposes each skill as a `skill_<id>` tool (risk `read`). Non-hidden skills are advertised in the system prompt so the model picks one when the user's request matches. `include` / `exclude` filters; strict mode on malformed SKILL.md; tool-name collision detection. 31 new tests.
- `postline doctor` now reports `mcp: N server(s) configured, …` and `skills: N loaded (advertised/hidden split)`.
- Biome config now honours `.gitignore` via `useIgnoreFile: true` — local smoke/dev configs (gitignored) no longer trip `pnpm lint`.
- Docs: `docs/TOOLS.md → MCP` and `→ Claude Code skills` sections, two FAQ entries, ROADMAP marks Phase 2b MCP + skill-loader as shipped.

### Fixed

- Skill tool-name collisions (`aws-html-slides` vs. `aws_html_slides` both sanitising to `skill_aws_html_slides`) are now detected at orchestrator level — first discovered wins, others logged and skipped.
- Skill tools' `inputSchema` now includes `additionalProperties: false` for consistency with other postline tool schemas.

[0.1.1]: https://github.com/Christianye/postline/releases/tag/v0.1.1

## [0.1.0] — 2026-05-11

First public release. All seven workspace packages ship at `0.1.0` together.

### Added

**Core framework** (`@postline/core`)

- Four interfaces: `Provider`, `Channel`, `Tool`, `Memory`. Stable for the 0.x line.
- Risk-tiered tools: `read` (auto-approved), `write` (allowlist-gated), `dangerous` (requires `/approve` gate).
- Structured `Logger`, `Turn` runner with tool-use loop, secret redaction helpers.

**Providers** (`@postline/providers`)

- `bedrock` provider (default): AWS Bedrock Runtime, streaming, tool use, vision, prompt caching.
- `anthropic` provider: `@anthropic-ai/sdk` 0.40, identical capability surface.
- `ProviderSpec` tagged union + `createProvider()` registry for third-party drop-ins.

**Channels**

- `@postline/adapters-feishu` — Feishu/Lark long-connection WSClient. @mention triggering, group + DM, image input, docx/wiki/sheet URL parsing, message splitting at 4500 chars.
- `@postline/adapters-cli` — Local TTY REPL (`pnpm chat`).

**Built-in tools** (`@postline/tools-builtin`, 9 ids)

- `echo`, `web_fetch` (SSRF-guarded), `fs` (read/write/edit), `memory` (list/read/write, git-backed), `github` (gh_query/gh_action), `lark_docs` (doc/wiki/sheet/bitable), `bash_read` (allowlisted safe subset, auto-approved), `bash` (dangerous, approval-gated), `feishu_send` (proactive send, allowlist + rate-limited).

**CLI** (`@postline/cli`, 6 subcommands)

- `chat` — local REPL.
- `feishu` — long-connection bot runner.
- `ask <prompt>` — one-shot turn, prints final text, exits 0. Good for cron.
- `init` — scaffold `postline.config.ts` in cwd.
- `doctor` — env + dep + config diagnostics.
- `upgrade` — `git pull && pnpm install && pnpm -r build && systemctl restart cc` on deployed hosts.

**Config** (`@postline/config`)

- `postline.config.ts` with `defineConfig()` helper.
- Four-level resolution: explicit path → `POSTLINE_CONFIG` env → walk-up from cwd → env-only fallback.
- Node 22+ native TypeScript config loading (`--experimental-strip-types`).

**Deployment**

- Templated `deploy/systemd/cc.service.template` → rendered per host via `install.sh` (substitutes `{{USER}}`, `{{REPO_DIR}}`, `{{CC_HOME}}`, `{{NODE_BIN}}`).
- `deploy/upgrade.sh` for in-place rolling updates.
- Memory auto-sync via cron against a private git remote.

**Examples**

- `examples/minimal` — 20-line config, `bash_read` + `echo`.
- `examples/full` — every tool, both providers, both channels.
- `examples/daily-report` — cron-driven `postline ask` → feishu group post.

**Docs**

- `README`, `CONTRIBUTING`, `SECURITY`, `CODE_OF_CONDUCT`, `CHANGELOG`.
- `docs/`: `ARCHITECTURE`, `CONFIG`, `PROVIDERS`, `TOOLS`, `THREAT_MODEL`, `COOKBOOK` (10 recipes).

**CI & release**

- GitHub Actions matrix: ubuntu + macos × Node 22. Build → typecheck → test → lint → secret-scan.
- [changesets](https://github.com/changesets/changesets) configured for future per-package releases.
- `.gitignore` hardened against leaking `postline.config.ts`, `.env`, keys, editor state.

### Security

- Feishu scopes documented at minimum needed (`im:message` + `docx:document:readonly` family; `contact:*` explicitly excluded).
- Outbound network surface enumerated in `docs/THREAT_MODEL.md` (5 hosts).
- `feishu_send` hard allowlist of `chat_id` / `open_id` targets, default empty = disabled.
- `bash` classifier splits each sub-command separately — `2>&1;` no longer masks a `;` chain.
- Secret redaction on all tool outputs + log lines.
- Upstream axios CVEs tracked as upstream-pinned (`@larksuiteoapi/node-sdk`); no direct postline exposure.

### Stats

- 168 tests passing, 0 typecheck errors, 0 lint warnings.
- 191 production dependencies, zero GPL/AGPL (MIT/Apache/BSD only).
- Git history scrubbed of personal email and instance identifiers before publication.

[0.1.0]: https://github.com/Christianye/postline/releases/tag/v0.1.0

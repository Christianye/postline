# Changelog

All notable changes to postline are recorded here. Format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow [SemVer](https://semver.org/).

Per-package changelogs live under `packages/*/CHANGELOG.md` once [changesets](https://github.com/changesets/changesets) starts writing to them. This top-level file tracks repo-wide releases.

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

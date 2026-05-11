# Changelog

All notable changes to postline are recorded here. Format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow [SemVer](https://semver.org/).

Per-package changelogs live under `packages/*/CHANGELOG.md` once [changesets](https://github.com/changesets/changesets) starts writing to them. This top-level file tracks repo-wide releases.

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

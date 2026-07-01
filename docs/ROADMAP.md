# Roadmap

This is a living document. Dates are directional, not commitments. Anything marked "community" is something the maintainers welcome as a PR but will not ship first-party.

> **Positioning (2026-06-08 reframe, refined 2026-07-02).** postline is **your AI coding agent, in your pocket** — a lightweight, extensible mobile front-end for Claude Code / Codex. It's pluggable on two axes (IM × agent) and the model layer is optional: by default it holds no LLM and delegates to the agent on your host, but an embedded LLM can be flipped on. The phases below predate the reframe; the **Doorbell + IM × agent matrix** section directly below reflects what actually shipped (0.5.0 → 0.7.0). See [docs/designs/postline-reframe.md](designs/postline-reframe.md).

## Doorbell + IM × agent matrix ✅ Shipped (0.5.0 → 0.6.0)

Goal: dispatch a repo-scoped task from any IM to a Claude Code / Codex session running anywhere, and stream progress back into the same message.

- [x] **Doorbell** (0.5.0): HMAC-authed dispatch endpoints + per-cwd FIFO queue + worker registry + `routing.md` router + `cc-worker` subcommand + in-place progress edits.
- [x] **Telegram + Slack adapters** (0.6.0): first-party, zero-dependency (`@postline/adapters-telegram` long-poll, `@postline/adapters-slack` Socket Mode), sharing a channel-agnostic turn-runner with Feishu.
- [x] **Codex agent kind + selector routing** (0.6.0): `cc-worker --agent codex`; `!pl@<selector>@<repo>` picks a worker by agent-kind or host.
- [x] **Auto-default-worker keeper** + **config-driven resident deployment** (0.6.0).

## Phase 1 — Personal 24/7 deployment ✅ Done (2026-05-09)

Goal: one operator, one Feishu workspace, a bot that stays alive.

- [x] M0–M5: scaffold → core → bedrock provider → feishu adapter → builtin tools → EC2 systemd.
- [x] Brand migration `clawbot-feishu` → `postline` (2026-05-10).

## Phase 2a — Open-source preparation ✅ Done (2026-05-11)

Goal: the repo does not embarrass us if a stranger clones it.

- [x] Provider registry + `anthropic` provider.
- [x] `postline.config.ts` + `defineConfig()`.
- [x] Tool registry (config-driven, not hardcoded).
- [x] README + examples + CI + changesets.
- [x] Pre-public audit: personal identifiers, secrets, dependency CVEs, LICENSE compliance, network surface, feishu scopes.
- [x] 0.1.0 release.

## Phase 2b — Ecosystem adapters (next)

Goal: ride existing protocols instead of inventing them.

- [x] **MCP client** — stdio transport, reads Claude Code / Claude Desktop's `~/.claude.json → mcpServers`, exposes each server's tools as `mcp_<server>_<tool>`. Risk tier is `dangerous` by default with per-tool overrides. Shipped 2026-05-11.
- [x] **MCP client — HTTP / SSE transports.** Remote MCP servers (`type: 'http' | 'streamable-http' | 'sse'`) work via request-header auth (OAuth flows deferred). Shipped 2026-05-12.
- [ ] **MCP client — OAuth + WebSocket.** Full OAuth flow for HTTP/SSE transports; WebSocket transport if demand appears.
- [ ] **MCP `resources` and `prompts` surfaces.** MVP only adapts `tools`. Resources should flow into context as inline blobs; prompts should become canned slash commands.
- [x] **Claude Code skill loader** — reads `~/.claude/skills/<name>/SKILL.md`, exposes each skill as `skill_<id>` (read tier), advertises non-hidden ones in the system prompt. `disable-model-invocation: true` honoured. Shipped 2026-05-11.
- [ ] **Skill script execution** — MVP does not run `SKILL.md` bash blocks or `scripts/*.py` automatically. Future work: route skill scripts through a sandboxed `skill_run` tool with its own risk tier.
- [ ] Optional: OpenClaw plugin shim. Only if a community contributor wants it — we don't use OpenClaw ourselves.

Non-goals here: universal plugin manager, cross-project skill registry, web UI for editing skills.

## Phase 2c — Community providers

Goal: let people use postline with the model they already pay for.

Maintainers will review PRs for:

- OpenRouter
- Moonshot (月之暗面)
- 阿里云百炼 / 通义
- 火山方舟 / 豆包
- DeepSeek
- Gemini (via Vertex or direct)

Requirements for inclusion: streaming + tool use + `convertMessages` unit tests + a README section. A non-streaming provider will not be merged.

## Phase 3 — Channels beyond Feishu

The `Channel` interface is stable and intentional. First-party adapters are now **four**: CLI, Feishu/Lark, Telegram, and Slack (the last two shipped in 0.6.0 — the reframe made "more IMs" the core product, so they moved first-party). Further channels stay community:

- Discord / IRC / WhatsApp / Matrix.

Channel adapters are small (each is well under ~1k LoC). Requirements: `Channel` implementation + matching CLI subcommand + approval UX appropriate to the platform + docs on rate limits and message size.

## Non-goals

These will not be built, regardless of demand:

- **Universal plugin system / dynamic code loader.** Four interfaces, exhaustive switches, no magic.
- **Multi-tenant / RBAC / org hierarchy.** One deployment serves one person or team. The allowlist is a list.
- **Web UI or dashboard.** postline is a bot, not a SaaS.
- **Vector database / embedding memory.** Memory is Git + files. If you want RAG, build it as a `Tool`.
- **Redis / Kafka / any extra infra.** A Node process, local files, GitHub, and one LLM provider. That is the whole stack.
- **CSS / frontend framework dependencies.** Nothing in this repo renders HTML.
- **Auto-update-on-main.** Deployments pin to tags via `deploy/upgrade.sh`. No background self-update.

## How decisions get made

1. Open a [Discussion](https://github.com/Christianye/postline/discussions) before starting a PR larger than ~200 lines or touching a cross-package interface.
2. Maintainers prioritise **stability over features** and **small interfaces over configurability**. Expect to have scope cut.
3. A feature that conflicts with the non-goals list above will be closed — open a Discussion first if you think the list should change.

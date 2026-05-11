# Roadmap

This is a living document. Dates are directional, not commitments. Anything marked "community" is something the maintainers welcome as a PR but will not ship first-party.

## Phase 1 — Personal 24/7 deployment ✅ Done (2026-05-09)

Goal: one operator, one Feishu workspace, a bot that stays alive.

- [x] M0–M5: scaffold → core → bedrock provider → feishu adapter → 9 tools → EC2 systemd.
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
- [ ] **MCP client — HTTP / SSE / WebSocket transports.** MVP was stdio-only. Add remote transports so users can point at hosted MCP servers (OpenAI, Notion, etc.).
- [ ] **MCP `resources` and `prompts` surfaces.** MVP only adapts `tools`. Resources should flow into context as inline blobs; prompts should become canned slash commands.
- [ ] **Claude Code skill loader** — read `~/.claude/skills/` and surface them to the model the same way Claude Code does. Keeps muscle memory portable.
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

The `Channel` interface is stable and intentional. First-party adapters stay two: CLI and Feishu. Everything else is community:

- Slack / Discord / Telegram / IRC / WhatsApp.

Channel adapters are small (`packages/adapters-feishu` is ~1k LoC). Requirements: `Channel` implementation + matching CLI subcommand + approval UX appropriate to the platform + docs on rate limits and message size.

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

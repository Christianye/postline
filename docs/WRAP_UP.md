# postline — wrap-up (2026-07-02)

A milestone marker at the point active first-party development was paused. Not a
deprecation notice — the repo is healthy, released, and open to PRs. This
records **where things stand** so anyone (including a future maintainer) can
pick it up cold.

## State at wrap-up

- **Version:** `v0.7.0` — tagged, GitHub release published, `tag == main`.
- **`main`:** `262c224` (`chore(release): 0.7.0 (#79)`).
- **Open PRs / issues:** 0.
- **Tests:** 805 passing (65 files). Build ✓ · typecheck ✓ · lint (biome) clean ✓.
- **Packages:** 12, all lockstep at `0.7.0`, all `private: true` (no npm publish).

## What shipped, by story chapter

The product reframed on 2026-06-08 from "a Feishu bot framework" to **"the
missing IM connector for Claude Code"** — a bridge that carries bytes between an
IM and your Claude Code / Codex sessions, holding no LLM of its own by default.
See `docs/designs/postline-reframe.md`.

| Chapter | Theme | Status |
|---|---|---|
| 1–3 | Personal 24/7 Feishu bot · OSS prep · ecosystem adapters (MCP client, skill loader) | ✅ 0.1.0 → 0.4.0 |
| 3.5 (Doorbell) | HMAC dispatch + per-cwd queue + worker registry + `routing.md` router + `cc-worker` | ✅ 0.5.0 |
| 4 (Total switchboard) | IM × agent matrix — Telegram + Slack adapters, Codex agent kind, selector routing, live progress, auto-worker keeper, resident deploy | ✅ 0.6.0 |
| 5 (Moving in for 老张) | 5-minute getting-started — doctor dispatch self-check, `/health`, QUICKSTART, channel-aware init, `routing.md` starter, first-message self-intro | ✅ 0.7.0 |
| 6 (Multi-host) | Multiple hosts, multiple workers, one operator | ⏸ not started |

0.7.0 also folded in the **post-0.6.0 health-check audit backlog**: three
security fixes (`bash_read` sandbox bypasses #69, worker→IM secret redaction #70,
allowlist-gated dispatch #71), the audit backlog #76, and a batch of robustness
fixes (at-most-once provider fallback #72, bounded task map #66, selector-aware
dispatch #73, surfaced handler errors #67). Full detail in `CHANGELOG.md`.

## Architecture, in one breath

A Node monorepo (pnpm workspaces). `@postline/core` holds the agent turn loop,
tool registry, redactor. Providers (`anthropic`, `bedrock`) stream + do tool use
behind a shared `runModelChain` (at-most-once content). Four first-party
channels (CLI, Feishu/Lark, Telegram, Slack) implement one `Channel` interface;
Telegram/Slack/CLI share a channel-agnostic `im-bridge` turn-runner, Feishu keeps
a richer bespoke path. The **Doorbell** (`@postline/doorbell`) is an HMAC-authed
dispatch server + per-cwd FIFO queue + worker registry; a `cc-worker` process
registers per `(cwd, agentKind)` and backs a dispatched task with `claude -p` or
`codex exec`. `routing.md` maps IM messages → repos/workers. No database, no
Redis, no web UI — Node + local files + Git + one LLM provider. See
`docs/ARCHITECTURE.md`.

## How to run / verify (from a cold clone)

```bash
pnpm install
pnpm -r build          # tsc across all packages
pnpm typecheck
pnpm test              # vitest — 805 tests
pnpm lint              # biome
node packages/cli/dist/bin.js --version   # → postline 0.7.0
node packages/cli/dist/bin.js doctor      # env + dispatch-path self-check
```

New-user path is `docs/QUICKSTART.md` (`init → bridge → cc-worker → !pl@<repo>`).

## Deployment note (for the maintainer)

- **No GitHub Actions deploy.** Shipping is manual: `deploy/scripts/upgrade.sh`
  on the box (pull → rebuild → restart the service), or `push-via-ec2.sh` from a
  laptop that can't push directly.
- **`upgrade.sh` fast-forwards `origin/main`, it does not pin a tag** — despite
  `ROADMAP.md` describing tag-pinned deploys. So the next `upgrade.sh` run pulls
  `0.7.0` (with the security fixes) automatically. If you *want* reproducible
  tag-pinned deploys, that's a small unbuilt change to `upgrade.sh`.
- The resident deployment (Feishu/Telegram/Slack bridges + keeper) is driven by
  `deploy/launchd/` + a per-host config; `install-resident.sh` wires it.

## Picking it back up

- **Roadmap:** `docs/ROADMAP.md`. Next unbuilt first-party chapter is **6 —
  multi-host**. Everything else is community-tier (Discord/WhatsApp/Matrix
  channels, community providers, MCP OAuth/WebSocket, skill script execution).
- **Design docs:** every substantive feature has an RFC under `docs/designs/`;
  every multi-PR sprint has a `docs/SPRINT_PLAN_*.md`.
- **Non-goals** (hard): universal plugin loader, multi-tenant/RBAC, web UI,
  vector DB, extra infra (Redis/Kafka), auto-update-on-main. See
  `docs/ROADMAP.md#non-goals`.

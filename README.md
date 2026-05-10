# postline

> A Feishu/Lark bot powered by Claude (via Bedrock / Anthropic API), built for Chinese dev teams who want an always-on LLM teammate in their group chats.

**Status**: Phase 1 — under active development, not yet recommended for others to run.

## What it is

A small, opinionated, hackable LLM agent that:

- Lives in your Feishu/Lark workspace as a bot
- Uses Claude (Bedrock by default, Anthropic/OpenRouter pluggable) for inference
- Can read & write files, run shell commands (with approval), query GitHub, talk to other agents
- Remembers things via a git-backed memory repo
- Runs 24/7 on a small VM via systemd

## Design principles

- **Decoupled by interface**: `Provider`, `Channel`, `Tool`, `Memory` — four interfaces, four seams. No god-class.
- **Security-first**: allowlist by open_id, tool risk tiers, secret redaction in logs, 8-point threat model
- **TypeScript strict**, `biome` lint, `vitest`, `changesets` release
- **Stackable**: same codebase can run a `postline chat` CLI, or a feishu bot, or (later) a slack bot

## Architecture

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

## Quickstart

Not yet. Will land in Phase 2.

## License

MIT

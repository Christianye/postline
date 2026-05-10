# Contributing to postline

Thanks for considering a contribution. This repo values **small, reversible, well-tested** patches over large architectural rewrites. Read this first.

## Before you PR

1. Open an issue or discussion if your change is larger than ~200 lines or touches a cross-package interface. Cheap to discuss up front, expensive to re-architect in review.
2. Run the full gate locally:

```bash
pnpm install
pnpm -r typecheck     # must be 0 errors
pnpm test             # must be all green
pnpm lint             # must be 0 warnings
pnpm -r build         # must succeed
```

3. No `--no-verify`, no `--force-with-lease` on `main`, no amending a published commit. If a pre-commit hook fails, fix the cause.

## Commit format

Conventional Commits + Claude co-author footer:

```
<type>(<scope>): <subject>

<why, 1-2 sentences>

- <what change 1>
- <what change 2>

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
```

- `type`: `feat` / `fix` / `docs` / `chore` / `refactor` / `test` / `perf`
- `scope`: package or feature (`core`, `providers`, `feishu`, `cli`, `config`, `tools`, `deploy`, `ci`)
- Subject in lowercase, imperative, ≤72 chars
- Body first paragraph is the **why**, bullets are the **what**

## PR description

Exactly five sections — we reject PRs without them:

- **Why** — what problem
- **What changed** — bullet list of concrete changes
- **Test plan** — markdown checklist of how you verified
- **Risk / rollout** — migration / feature flag / incident fallback
- **Invariants** — project constraints kept (e.g. "no change to `Provider` interface"); write "N/A" if none

## Adding a new provider

Template: `packages/providers/src/bedrock/index.ts`.

Minimum to PR:

1. New directory `packages/providers/src/<yourname>/` with an `index.ts` that exports `<Yourname>Provider implements Provider`.
2. Add a variant to `ProviderSpec` in `packages/providers/src/registry.ts` and the `createProvider` switch.
3. Unit tests for `convertMessages` covering text / tool_use / tool_result / image parts + stop-reason mapping.
4. README update under **Providers** section.
5. **No changes** to the `Provider` interface in `@postline/core` — if you think you need new capabilities, open a discussion first.

## Adding a new built-in tool

Template: any of `packages/tools-builtin/src/*.ts` (e.g. `echo.ts` for the simplest form, `bash.ts` for the full shape).

1. Export `createYourTool(opts): Tool` (or `Tool[]` if it's a family like `fs` or `memory`).
2. Wire into `packages/tools-builtin/src/registry.ts` under a new `BuiltinToolId`.
3. Add matching field to `ToolOptions` in `packages/config/src/types.ts`.
4. Unit tests. If the tool has a classifier (like `bash_read`), tests must cover both allow and reject cases.
5. Update the tool table in README.

**Risk tier rules**:

- `read` = no side effects. Auto-approved. Must not write files, open sockets, mutate process state, or call external APIs with side effects. `web_fetch` is read because it's GET-only with SSRF guards.
- `write` = local / user-scoped writes (fs in allowlist, memory git commits). Requires allowlist membership but not per-call approval.
- `dangerous` = arbitrary writes / network / external systems (bash, gh_action). Requires `/approve <id>` interactive gate.

If in doubt, pick the higher tier and let users relax.

## Adding a new channel (Slack, Discord, IRC, ...)

Template: `packages/adapters-feishu/`.

1. New package `packages/adapters-<channel>/` implementing `Channel` from `@postline/core`.
2. Add a new CLI subcommand in `packages/cli/src/cmd-<channel>.ts` with approval UX appropriate for that channel (slash commands / inline buttons / reactions).
3. Config type extension in `PostlineConfig`.
4. Document channel-specific constraints (rate limits, message size, image support).

## Code style

- Biome enforces the rules. No bikeshedding.
- `exactOptionalPropertyTypes: true` — never pass `undefined` where a key can be absent; use `...(value ? { key: value } : {})`.
- No `any` except behind a `// eslint-disable-next-line` with a justification comment.
- Log with `pino` through `@postline/core`'s `Logger` interface — don't `console.log` in production code.

## Versioning and release

We use [changesets](https://github.com/changesets/changesets). When your PR has a user-facing change:

```bash
pnpm changeset
```

Pick `patch` / `minor` and write a one-sentence summary. Commit the generated markdown in `.changeset/`. The release workflow picks it up.

## Questions?

Open a discussion: https://github.com/Christianye/postline/discussions.

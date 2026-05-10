# Changesets

Every user-facing change should come with a changeset describing what it does. To add one:

```bash
pnpm changeset
```

Pick the affected package(s), the semver bump (patch / minor / major), and write a one-sentence summary. The generated `.md` file goes in this directory and travels with the PR.

When `main` merges, the release workflow rolls up all pending changesets, bumps the packages, updates changelogs, and (once wired) publishes to npm.

## What warrants a changeset

- New public type, function, or CLI flag
- Breaking changes to any `Provider` / `Channel` / `Tool` / `Memory` / `Config` shape
- Bug fixes visible to users
- Dependency version bumps that affect runtime behavior

## What doesn't

- Internal refactors with no surface change
- README / docs-only edits (we release docs with every merge anyway)
- CI / test / tooling changes

## Versioning policy (pre-1.0)

While we're still on 0.x:

- Breaking API changes → `minor` bump (0.1.x → 0.2.0)
- New features → `minor` bump
- Bug fixes → `patch` bump (0.1.0 → 0.1.1)

Graduating to 1.0 will happen after Phase 2b ships and we run for a month without breaking changes.

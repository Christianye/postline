---
'@postline/core': minor
'@postline/doorbell': minor
'@postline/adapters-cli': minor
---

feat(router): configurable wake-prefix + agent-kind selector + responder attribution

**BREAKING**: the override-prefix grammar changed (no back-compat).

- `!cc` / `!cc:repo` / `!cc:repo@host` → `!pl` / `!pl@repo` / `!pl@selector@repo`
- `!ec2` / `!plain` → `!pl ec2` / `!pl plain` (sub-keyword form)
- Wake-name `pl` is configurable via a `## wake` section in `routing.md` (default `pl`; reserved words `ec2`/`plain` rejected).
- 3-segment middle slot is a **selector** matching a worker's `host` OR `agentKind` (cc / codex / …). Workers now report `agentKind` on registration (`cc-worker` sends `cc`); optional for back-compat.
- Every worker reply carries a **responder-attribution header**: `🤖 <agentKind>@<repo> · <host>`.

v1 note: the selector is parsed, carried, logged, and used for attribution, but dispatch remains cwd-keyed (one active worker per cwd). Selector-aware worker selection and auto-default-worker are tracked as follow-on designs.

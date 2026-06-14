# Wake-prefix redesign · `!cc:repo@host` → `!pl@selector@repo`

> Status: **FROZEN v2 · 2026-06-14** · Author: mac CC · Sole owner: mac CC · operator-approved
> Lifecycle: design → operator review → freeze → impl
> Trigger: `!cc:postline` is too long to type repeatedly. Operator wants a short,
> configurable wake-name (default `pl`), `name@target` handle syntax.

---

## 1 · Goal

Replace the routing override prefix grammar:

| Today | New |
|---|---|
| `!cc:postline run lint` | `!pl@postline run lint` |
| `!cc:postline@mac run lint` | `!pl@pl-mac run lint` (host encoded in alias) |
| `!cc run lint` (default mac dispatch) | `!pl run lint` (wake backing agent, no target) |
| `!cc ` (bare) → dispatch | `!pl` (bare) → wake the agent behind `pl` for a basic-question answer |

Two motivations from the operator:

1. **Short** — `!cc:` (4 chars + colon) → `!pl` (default, configurable).
2. **Future-proof** — the wake-name is the *bridge instance's* name, not hardwired
   to "cc". The operator may later run cc / codex / other agents behind one
   postline. So the name is **operator-configured**, default `pl` (postline).

---

## 2 · Grammar (three-segment, decided)

`@`-delimited, parsed by segment count:

```
!<wake>                       → 1 seg: wake the default agent behind this bridge,
                                no worker target. Answers basic questions.
!<wake>@<repo> <text>         → 2 seg: route to the (single) worker for <repo>.
!<wake>@<selector>@<repo> <t> → 3 seg: pick worker by <selector> within <repo>.
```

- `<wake>` — configurable, default `pl`. One token, `[a-z0-9-]+`. The bridge's
  name, not hardwired to "cc" (operator may run cc / codex / others behind it).
- `<repo>` — a key in routing.md `## worker_aliases`.
- `<selector>` (3-seg only) — disambiguates when multiple workers serve the same
  repo. Matches a worker's **`agentKind` (cc / codex / …) OR `host` (mac / ec2 /
  …)** — whichever the operator typed. So both intents are covered by one slot:

  ```
  !pl@postline          → the postline worker (when only one)
  !pl@cc@postline       → the cc-kind worker on postline
  !pl@codex@postline    → the codex-kind worker on postline
  !pl@ec2@postline      → the postline worker running on ec2 (host pin)
  !pl@mac@postline      → the postline worker on mac
  ```

### Why three-segment (operator pick, 2026-06-14)

The operator wants agent-kind addressing (cc/codex) as a first-class concept, not
hidden inside alias names. Three segments keep `repo` always last (stable to read)
and put the disambiguator in the middle. The selector is matched against the
worker registry's `host` and `agentKind` fields (union); exact match wins.

**Edge case** (documented, not solved in grammar): a host literally named `cc`
collides with agent-kind `cc`. Resolution order: try `agentKind` first, then
`host`. Operator avoids naming a host after an agent-kind. Logged on ambiguous
match.

### Registry impact

Worker registration must carry `agentKind` (today it carries `host` + `cwd`).
The `cc-worker` skill already knows what it is — it sends `agentKind: 'cc'`.
Future codex-worker sends `'codex'`. Selector match = `seg === host || seg ===
agentKind`. (Small registry field add; not a new subsystem.)

---

## 3 · Mode overrides track the wake-name (decided)

`!ec2` (self-solve with builtin tools) and `!plain` (direct-answer, no tools) are
*mode* overrides — they say **how** the bridge answers, not which worker. Operator
decided these should track the wake-name too. New form:

```
!<wake> ec2 <text>     → bridge self-solves with builtin tools  (was !ec2)
!<wake> plain <text>   → bridge direct-answers, no tools        (was !plain)
```

Sub-command style (`!pl ec2 …`) rather than glued symbols (`!pl=`, `!pl!`) —
readable, discoverable, and unambiguous against the `@`-routing forms (a space +
keyword vs `@`). `ec2` / `plain` become reserved sub-keywords after `!<wake> `.
These only fire when embedded LLM is enabled (off by default).

## 3a · Responder attribution (new, decided)

Every reply carries a one-line header naming **who answered**, so the operator
always knows which agent / host / repo produced it:

```
🤖 cc@postline · mac        ← worker reply (agentKind@repo · host)
🤖 pl · direct              ← bridge embedded-LLM direct answer
🤖 pl · self-solve          ← bridge builtin-tool answer
```

- Worker replies: header = `<agentKind>@<repo> · <host>`, prepended to the first
  streamed chunk (and kept across edits).
- Bridge replies (`!pl`, `!pl plain`, `!pl ec2`): header = `<wake> · <mode>`.
- Format lives in `cmd-feishu.ts` reply assembly; the worker sends its
  identity in the doorbell registration/poll payload (already has host+cwd; add
  agentKind per §2 registry impact).

---

## 4 · Config

routing.md gains one optional section:

```markdown
## wake
pl
```

- Single token, first non-empty bullet/line under `## wake`.
- Absent → default `pl`.
- Parser: `parseRoutingMarkdown` adds `wake: string` to `RoutingConfig`
  (default `'pl'`).
- `matcher.ts` `parseOverridePrefix` reads `cfg.wake` instead of the literal
  `cc`, builds the prefixes dynamically: `!${wake}`, `!${wake}@…`.

### Edge cases

- Wake-name collision with `ec2` / `plain`: validate on load; if `wake` is set
  to a reserved word, log warning + fall back to `pl`.
- Leading-`!` already stripped? No — `!` is part of the literal match, same as
  today.
- Case sensitivity: lowercase the wake-name on parse; match case-insensitively
  (operator typing `!PL` on mobile autocorrect should still work).

---

## 5 · Affected surface

~67 hand-written occurrences (108 incl. generated `dist/`):

| File | Change |
|---|---|
| `packages/core/src/router/matcher.ts` | parse rewrite — dynamic wake prefix; `@` segment-count (1/2/3) routing; `!<wake> ec2`/`plain` sub-keywords |
| `packages/core/src/router/matcher.test.ts` | rewrite all override cases → `!pl@…` 1/2/3-seg + sub-keyword cases |
| `packages/core/src/router/parser.ts` | add `## wake` section + `wake` field (default `pl`) |
| `packages/core/src/router/parser.test.ts` | wake-section parse + reserved-word collision tests |
| `packages/core/src/router/types.ts` | `RoutingConfig.wake`; selector match comment |
| **`packages/doorbell/*` (registry/types)** | add `agentKind` to worker registration + poll payload (selector match + responder header need it) |
| **`packages/cli/src/cc-worker/*`** | cc-worker sends `agentKind: 'cc'` on register |
| `packages/cli/src/cmd-feishu.ts` | hint strings `!cc:<repo>` → 3-seg form; **responder-attribution header** on every reply (§3a) |
| `docs/cc-worker.md` + `README.md` | operator-facing syntax (3-seg + sub-keywords + responder header) |
| `docs/designs/doorbell.md` / `postline-reframe.md` / `SPRINT_PLAN_DOORBELL.md` | frozen-doc supersession banner (no in-place rewrite) |
| CHANGELOG (core/config) | historical — **leave** (records what shipped) |

Scope grew vs v1: responder attribution + `agentKind` registry field pull in
`packages/doorbell` + `cc-worker`. Still one cohesive PR, but no longer
router-only.

**Frozen-doc policy**: doorbell.md / reframe.md / sprint docs are frozen records.
Don't rewrite their `!cc:` examples in place (that falsifies history like the v3
ratification). Instead add a one-line banner: "syntax superseded by
`docs/designs/wake-prefix-redesign.md` — `!cc:repo@host` → `!pl@alias`." Same
pattern as the doorbell.md reframe-supersession banner.

---

## 6 · Migration / breaking change

- **BREAKING**: existing `!cc:` muscle memory + any operator routing.md examples.
- The operator (sole user) updates their own routing.md `## worker_aliases`
  names and starts typing `!pl@…`. Zero external users (private deploy).
- Back-compat option (OQ2): keep `!cc:` as a hard-coded alias for `!pl@` for one
  minor version, log a deprecation line on use. Lean: **no back-compat** —
  single operator, clean break is simpler than carrying two grammars. Mark
  BREAKING in CHANGELOG; bump minor.

---

## 7 · PR breakdown

One cohesive PR:

```
feat(router): configurable wake-prefix + agent-kind routing + responder attribution
  ├── parser.ts        + ## wake section, RoutingConfig.wake (default 'pl')
  ├── matcher.ts       dynamic wake prefix; 1/2/3-seg @ routing; ec2/plain sub-keywords
  ├── doorbell types   + agentKind on register/poll payload
  ├── cc-worker        send agentKind: 'cc'
  ├── cmd-feishu.ts    hint strings + responder-attribution header (§3a)
  ├── *.test.ts        override cases, wake-config, collision, selector match
  ├── cc-worker.md + README.md   operator-facing syntax + responder header
  ├── frozen-doc banners (doorbell/reframe/sprint)  — supersession note, no rewrite
  └── changeset (minor, BREAKING note)
```

If the diff gets large, split: **PR-A** router+parser+matcher (prefix grammar),
**PR-B** doorbell agentKind + responder attribution. PR-A is self-contained
(selector match degrades gracefully if agentKind absent → host-only match).

---

## 8 · Open questions — RESOLVED (operator 2026-06-14)

- (OQ1) Rename `!ec2` / `!plain`? → **YES**, sub-command style `!<wake> ec2` /
  `!<wake> plain` (§3). Plus responder attribution on every reply (§3a).
- (OQ2) Back-compat `!cc:` one version? → **NO**, clean break. Single operator.
- (OQ3) `@` separator configurable? → **NO**, `@` fixed.
- (OQ4) Bare `!pl` with no worker? → Operator wants an **auto-default-worker
  (spawn one if none)**. Carved out as a **separate design** (§8a) — too big for
  this PR. v1 bare-`!pl` keeps today's behaviour: dispatch to default; no worker
  → `reject_no_worker` hint. The auto-spawn design replaces that branch later.

## 8a · Carve-out: auto-default-worker (separate doc)

Operator's OQ4 ask — "there should be a default worker; if none, start one" — is
a different order of magnitude than a prefix-parser change:

- **Process lifecycle**: who spawns, who reaps, resource caps.
- **Where**: postline runs on EC2 (reframe). Spawn a local headless `claude -p`
  on EC2? SSM-wake a Mac CC? The bridge doesn't currently hold compute.
- **Security**: spawning an agent process from an inbound IM message is a new
  attack surface — needs allowlist + sandbox reasoning.
- **Reframe tension**: postline-as-bridge explicitly "carries bytes, doesn't run
  compute" (RF2). Auto-spawn makes the bridge own worker lifecycle again — worth
  a deliberate decision, possibly its own RFC.

→ Tracked in a future `docs/designs/auto-default-worker.md`. **Not** in the
prefix PR. Until then bare `!pl` with no worker = `reject_no_worker`.

## 9 · Self-review checklist

- [ ] Does dynamic wake-prefix break the precedence order in `matchRoute`? (Override still runs first.)
- [ ] `@` in alias vs `@` in normal text — can a non-prefixed message starting with `!plword` false-match? (Anchor on `!<wake>` + space or `@`.)
- [ ] Wake-name regex — does `[a-z0-9-]+` cover operator intent without allowing `!pl:` ambiguity?
- [ ] Frozen-doc banner vs in-place rewrite — consistent with the doorbell.md precedent?

## Changelog

- **v2 · 2026-06-14 · mac CC**: operator review absorbed. (1) **3-segment** grammar
  `!pl@<selector>@<repo>` (selector = agentKind cc/codex OR host mac/ec2) — replaces
  v1 alias-encodes-host. (2) OQ1 → rename `!ec2`/`!plain` to sub-keywords
  `!pl ec2`/`!pl plain` + **responder attribution** on every reply (§3a). (3) OQ2 no
  back-compat. (4) OQ3 `@` fixed. (5) OQ4 auto-default-worker **carved out** to
  separate design (§8a) — bare `!pl` keeps `reject_no_worker` for now. Scope grew:
  pulls in `agentKind` registry field + responder header (doorbell + cc-worker).
- **v1 · 2026-06-14 · mac CC**: initial draft. `!cc:repo@host` → `!pl@alias`; wake-name operator-configurable via routing.md `## wake` (default pl); host encoded in alias (no third segment); `!ec2`/`!plain` unchanged; no back-compat (single operator). Awaiting operator review on OQ1-4.

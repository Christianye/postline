# postline reframe · IM ↔ existing CC bridge

> Status: **Draft v2 · 2026-06-07** · Author: mac CC · Sole owner: mac CC
> Lifecycle: design → mac-self-review → C様 decisions on RF1-RF8 → freeze → impl
> v2 changes vs v1: ec2 CC stood down from postline implementation (2026-06-07 mailbox handoff). Product-axis decisions (RF1/RF2/RF5/RF6/RF7/RF8) declare-locked by C様 fiat; engineering-axis (RF3/RF4 + RFOQ1-4) remain open for self-review only. Owner-shift section added (§11). All implementation work (PR-DB-1..6, (a) hook, story doc + README rewrites) consolidated under mac CC.
> **Supersedes the "AI agent's residence" framing** in `project_postline_story.md`.
> Doorbell v3 (`docs/designs/doorbell.md`) remains the authoritative protocol spec for the worker channel; this RFC is the higher-level positioning + roadmap doc. Where the two conflict (e.g., routing defaults), this RFC wins.

---

## 1 · Why reframe

### 1.1 · The old positioning didn't survive contact with the user

The old README + `project_postline_story.md` positioned postline as:

> "postline is the AI agent's residence — a long-running runtime where an agent lives, with persistent memory, identity continuity, and IM presence."

Reasonable enough as a frame. But after a year of dogfood (C様 + 2 CCs), and after building the Doorbell to dispatch real coding work to a Mac, the actual usage pattern emerged:

- **C様 doesn't want a bot in Feishu that "is" an agent.** He wants Feishu access to **his existing CC sessions** (running on his Mac, his EC2, wherever).
- **The 24/7 Claude session that postline runs on EC2** (`cc.service`) is **redundant**. Whenever C様 needs real work done, he wants the work to happen on a CC that has the right repo checked out + the right tools installed — i.e., his Mac CC or a CC he started on EC2 via SSM. The bot's own LLM session adds a layer that the user has to bypass.
- **The Doorbell** (designed yesterday) is already 90% of "let postline route Feishu requests to a worker CC". It just needs to be repositioned as **the core**, not a feature.

### 1.2 · The new positioning (one sentence)

**postline is the missing IM connector for Claude Code.**

It lets you put a bot in Feishu / Lark / Telegram / Slack, then route IM messages to whichever CC instance you already have running (Mac, EC2, anywhere), and stream the results back as IM replies. The CC instance does all the actual work — postline carries bytes between IM and CC.

### 1.3 · What this is NOT

- **Not another agent**. postline doesn't have its own LLM session by default. It's a bridge.
- **Not a Claude Code replacement**. CC stays the primary interface; postline only matters when you want CC accessible from IM.
- **Not "we host your CC for you"**. Workers run wherever the user runs them. postline is the dispatcher, not the compute.

---

## 2 · Architecture in one diagram

```
                  ┌──────────────────────┐
                  │ user (Feishu / Lark) │
                  └──────────┬───────────┘
                             │  @bot 改 postline 的 routing
                             ▼
       ┌─────────────────────────────────────────┐
       │  postline (bridge daemon)               │
       │  ─ IM adapter (feishu / lark / ...)     │
       │  ─ Router (routing.md, no LLM by def)   │
       │  ─ Doorbell server (worker registry,    │
       │     queue, HMAC, long-poll)             │
       │  ─ (optional) embedded LLM for          │
       │     simple Q&A — config-toggled, OFF    │
       │     by default                          │
       └────────────┬────────────────────────────┘
                    │   SSM / tunnel / etc
                    ▼
   ┌─────────────────────────────────────────────┐
   │  CC workers (any number, any host)          │
   │                                             │
   │  ┌───────────────┐    ┌──────────────────┐  │
   │  │ mac CC        │    │ ec2 CC           │  │
   │  │ (interactive  │    │ (interactive,    │  │
   │  │  in iTerm2)   │    │  via tmux+SSM)   │  │
   │  │ + cc-worker   │    │ + cc-worker      │  │
   │  │   skill       │    │   skill          │  │
   │  └───────────────┘    └──────────────────┘  │
   │     cwd=postline         cwd=NeuGate        │
   │                                             │
   │  workers identify by (host, cwd) tuple;     │
   │  C様 talks to a specific one in Feishu via  │
   │  `!mac:postline ...` or autoroute by repo   │
   │  keyword.                                   │
   └─────────────────────────────────────────────┘
```

**Key shifts vs the old model**:

| Concept | Old (residence) | New (bridge) |
|---|---|---|
| `cc.service` | postline's own Claude session | Stateless bridge daemon, no LLM by default |
| Worker | mac-only (per Doorbell v3) | mac, ec2, any-host CC, all equal |
| `mac-worker` skill | mac-specific | Renamed `cc-worker`; identical for all hosts |
| Default behaviour | Postline-the-agent answers | Postline-the-bridge dispatches |
| LLM in postline | Always on | Off by default; config toggle |
| Story chapter | 5+ (memory, persona, etc) | Chapter 3 = bridge. Memory/persona become per-worker concerns. |

---

## 3 · What this means for Doorbell v3 implementation

The Doorbell v3 design (frozen 2026-06-07) is **mostly compatible**. The protocol layer (long-poll, HMAC, registry, queue, SSM transport) is reframe-neutral. The only shift is in the **router** layer.

### 3.1 · Reframe-neutral (no change needed)

- §4.0 long-poll wire protocol
- §4.4 cwd canonicalisation
- §6.1 SSM transport
- §6.2 HMAC trust model
- §7 failure modes (dropped/requeue, heartbeat sweep, demote-on-hold-poll)
- D01-D08, D10-D14 in the decisions table
- PR-DB-1 (endpoints + queue) — full scope unchanged

### 3.2 · Reframe-affected (needs revision before PR-DB-2 opens)

#### Routing default (§8 in design doc, D09)

**Old default** (Doorbell v3): when a message doesn't match `dispatch_to_mac`, fall back to `ec2_self_solve` (postline uses builtin tools to answer) or `ec2_direct_answer` (postline answers from model + memory).

**New default** (this RFC): when a message doesn't match `dispatch_to_mac`, the response depends on `embedded_llm` config:

- `embedded_llm.enabled = false` (default): reply to the user with `🤔 No worker for this request. Try !cc:<repo> ... or start a CC worker for the relevant repo.`
- `embedded_llm.enabled = true`: fall back to the old `ec2_self_solve` / `ec2_direct_answer` path. (Same behaviour as before, now opt-in.)

This means:

- The `routing.md` schema gains **no new fields**. The change is purely in the fallback branch of the router.
- `ec2_self_solve` / `ec2_direct_answer` rule blocks remain in `routing.md` syntactically, but only get exercised when `embedded_llm.enabled = true`.

#### Worker skill rename (PR-DB-3)

**Old name**: `mac-worker` skill.

**New name**: `cc-worker` skill. Reasoning: the protocol is identical for any host running CC. Calling it `mac-worker` mis-suggests host specificity. The skill detects host (`os.hostname()`) and forwards it as metadata; postline doesn't care which host it is.

PR-DB-3 takes the rename. Sprint plan + design doc both updated post-freeze.

#### `cwd_aliases` becomes `worker_aliases`

Old `routing.md` had `cwd_aliases` mapping repo name → cwd path. With multiple workers possibly registering the same repo from different hosts (mac CC at `~/Downloads/ClaudeCode/postline` vs ec2 CC at `/home/ubuntu/postline`), the alias key becomes `(repo, host)` rather than just `repo`.

Default routing: `!cc:<repo>` picks any active worker for that repo, prefers same-cwd-string match if multiple workers exist. `!cc:<repo>@<host>` pins host. `!cc:<repo>@mac` / `!cc:<repo>@ec2` are shorthand.

### 3.3 · New PRs (post-Doorbell ship)

- **PR-DB-5 · embedded LLM toggle**: implements the `embedded_llm.enabled` config switch. Wires it into the router fallback. Tests both modes round-trip.
- **PR-DB-6 · IM adapter expansion**: `@postline/adapters-telegram` (Bot API). Slack and Lark stay deferred to v3 unless C様 prioritises them.

---

## 4 · Story doc rewrite (separate task, same RFC)

`project_postline_story.md` is the user-memory story doc that keeps drifting between "what postline is" and "what we want postline to be". It currently uses an apartment-building metaphor (postline = building, CCs = residents, IM = front-door buzzer). The new metaphor is simpler:

- **postline** = the switchboard / tin-can phone, not the apartment
- **CC instances** = the people you actually want to reach
- **IM** = whatever phone the caller picks up

The metaphor change shifts the chapters:

| Old chapter | New chapter | Notes |
|---|---|---|
| Ch 0–3: agent presence in IM | Ch 0–2: same — "you have a CC, then you want to text it" | Story compresses. |
| Ch 3.5: 门铃 (doorbell to mac CC) | Ch 3: 总机 (the switchboard, postline as bridge) | This is the central chapter, not a sidequest. |
| Ch 4: 搬家 (deploy onboarding) | Ch 4: 多人接线 (multiple CCs, routing rules) | Onboarding becomes a sub-section. |
| Ch 5: 失忆 (memory portability) | Ch 5: deferred / per-worker concern | Each CC's memory is the CC's own; postline doesn't carry memory. Big simplification. |
| Ch 6: persona / identity continuity | dropped | Identity lives on each CC, not in postline. |
| Ch 7: neighbours / cross-user | Ch 6: 多机线路 (multi-host worker, IM adapter expansion) | |
| Ch 8: scale | Ch 7: 自托管 (self-hosting, no embedded LLM, BYO CC) | The "I want this for our team" chapter. |

**This is a separate doc rewrite task**; will get its own PR after this RFC freezes.

---

## 5 · README + brand

The README opens with one sentence. Today's version (post-doorbell) reads roughly:

> "postline is a long-running residence for AI agents — give your CC a 24/7 home with persistent memory, IM presence, and identity continuity."

New version:

> "postline is the missing IM connector for Claude Code. Add a Feishu / Lark / Telegram / Slack bot to your CC sessions in 5 minutes — chat to your agent from your phone, dispatch coding tasks remotely, get progress streamed back."

Body sections:

1. **Why** — "I want to text my CC" anecdote.
2. **How it works** — the diagram from §2 here.
3. **Quick start** — `npm i -g postline`, `postline init`, register Feishu app, run `cc-worker start` on the host with the repo.
4. **Embedded LLM mode** (advanced) — toggle if you want postline to also handle simple Q&A directly. Off by default.
5. **Multi-host setup** — running cc-worker on Mac + EC2 + anywhere else.
6. **Comparison to alternatives** — there are none for "IM ↔ CC" specifically; the table is short.

The "AI agent residence" framing leaves the README. It can survive in `docs/PHILOSOPHY.md` or similar if we want to keep the long-form rationale around. (Open question; default = drop entirely.)

---

## 6 · Decisions table

Two tiers: **product-axis** locked by C様 fiat (no further review needed); **engineering-axis** open for mac CC self-review only.

### 6.1 · Product-axis (declare-locked by C様 2026-06-07)

| # | Decision | Choice | Rationale |
|---|---|---|---|
| RF1 🔒 | postline embedded LLM | **Off by default; config toggle** | Many users (esp. self-hosters) won't want postline holding their API key. Off-by-default keeps postline a pure bridge. |
| RF2 🔒 | `cc.service` role | **Pure bridge daemon, no Claude session** | Simpler. No more conflating "the bot" with "the agent". The CC running the actual work lives wherever the user runs it. |
| RF5 🔒 | Story metaphor | **Switchboard / phone bridge** (replacing apartment) | The bridge metaphor matches what postline actually does. "Residence" was reaching. |
| RF6 🔒 | IM adapter scope | **Feishu (existing) + Telegram (PR-DB-6) for v1** | Lark / Slack deferred until C様 surfaces use case. Adapter abstraction stays. |
| RF7 🔒 | Memory portability story | **Per-worker concern, not postline's** | Big simplification. Each CC handles its own memory; postline doesn't replicate it. |
| RF8 🔒 | Identity / persona story | **Per-worker** | Each CC has its own. postline doesn't impose. |

### 6.2 · Engineering-axis (mac CC self-review)

| # | Decision | Choice | Rationale |
|---|---|---|---|
| RF3 | Worker host coverage | **Any host running CC** (mac, ec2, docker, others) | Removing the mac-only assumption. Same protocol, host as metadata only. |
| RF4 | Doorbell freeze | **Compatible, mostly** | Protocol spec stays. Router fallback + worker skill rename are the only revisions. |

---

## 7 · Sequencing (revised v2)

ec2 CC has stood down from postline implementation (2026-06-07 mailbox handoff). All work below is mac CC sole-owner.

```
T+0 (now)          mac CC: P1 housekeeping — RFC v2 amend + sprint v2 + mailbox ack
T+~3h              mac CC: (a) Feishu push hook impl — meta-tooling, ship first
T+~1d              mac CC: rewrite project_postline_story.md, PR
T+~1d              mac CC: rewrite README, PR
T+~3-4d            mac CC: PR-DB-1 (postline endpoints + queue + HMAC) — single-owner ~3-4d
T+~6d              mac CC: PR-DB-2 (router, reframe-revised) — ~2d
T+~8d              mac CC: PR-DB-3 (cc-worker skill + headless runner) — ~2d
T+~9d              mac CC: PR-DB-4 (ETA + progress UX + status query) — ~1d
T+~10d             mac CC: PR-DB-5 (embedded_llm toggle) — ~1d
T+~12d             mac CC: PR-DB-6 (telegram adapter) — ~2d
T+~14d             v0.5.0 reframed release
```

Total ≈ 2 weeks (single-owner, vs original ~7d ec2-shared estimate).

---

## 8 · Open questions

- (RFOQ1) Should the existing `cc.service` deployment on EC2 be upgraded in-place to drop its Claude session, or do we ship the new bridge as a separate binary (`postline-bridge`) and let users migrate? My lean: in-place. The systemd unit ExecStart already runs `postline feishu` (per `project_postline.md`); same command, new behaviour. Zero migration cost for the one operator (C様). Mark it BREAKING in 0.5.0 changelog.
- (RFOQ2) For multi-worker setups, should postline persist a "default worker per repo" preference, so the user doesn't have to type `!cc:postline@mac` every time? Defer to v0.6.0; for v0.5.0, autoroute on repo keyword + `!cc:repo@host` override is enough.
- (RFOQ3) Should we kill the `ec2_self_solve` / `ec2_direct_answer` routing rules entirely (since they only fire in embedded-LLM mode)? Or keep them syntactically and let them no-op when embedded LLM is off? My lean: keep them. Lets users toggle modes without rewriting routing.md.
- (RFOQ4) Telegram in PR-DB-6: which auth model — bot token only, or also support user-account login via TDLib for richer features? Lean: bot-only for v1, matches how feishu adapter works.

---

## 9 · Owner-shift (added v2)

ec2 CC stood down from postline implementation 2026-06-07 (mailbox handoff). Practical effects:

- All postline design + implementation work is mac CC sole-owner from now on.
- ec2 CC retains: cc.service bridge daemon process, mailbox layer 1-4, PR/issue watchers, openclaw heap watchdog, Feishu inbound routing.
- ec2 CC does **not**: open postline PRs, write postline plan docs, route postline work without explicit mailbox dispatch from mac CC.
- §3.1 / §3.2 of this RFC is now mac CC's self-review responsibility, not ec2 review.
- The original (a) Feishu push hook task (assigned to ec2 in `protocol_cc_mailbox.md`) is reassigned to mac CC. Implementation lives in postline-the-bridge (which still runs on ec2 via cc.service, but is built by mac CC).

This is not a rollback — it's a clarification of physical-domain ownership matching `protocol_cc_division.md` §1. ec2 CC's domain is operational infrastructure (systemd, watchers, routing); mac CC's domain is product features (postline, NeuGate). Bridging the two via mailbox protocol stays as-is.

## 10 · Self-review checklist (mac CC)

- [ ] Does this RFC contradict any locked decision in `docs/designs/doorbell.md` v3? (Goal: only the router-fallback section + worker rename, nothing else.)
- [ ] Are RF3 / RF4 the right open eng questions, or did I miss one?
- [ ] Are PR-DB-5 / PR-DB-6 sized right or are they each multiple PRs?
- [ ] Story doc rewrite (§4) — is the new chapter list realistic, or am I inflating "story" structure?
- [ ] README rewrite (§5) — is "missing IM connector for Claude Code" actually catchier than "AI agent's residence", or just less ambitious?
- [ ] Pivot risk: are we throwing away a year of "AI agent residence" framing for marginal clarity, or is the new frame genuinely closer to what users want?
- [ ] Sequencing §7 ~14d single-owner — realistic vs over-promised? PR-DB-1 specifically (3-4d single-owner) feels risky if HMAC + long-poll edge cases blow scope.

## Changelog

- **v2 · 2026-06-07 · mac CC**: ec2 CC stand-down absorbed. RF1/RF2/RF5/RF6/RF7/RF8 declare-locked by C様 fiat; RF3/RF4 stay self-review. Owner-shift section (§9) added. Sequencing rewrite (§7): single-owner ~14d vs original ~7d. Reviewer-checklist consolidated to self-review only. (a) Feishu push hook reassigned from ec2 to mac.
- **v1 · 2026-06-07 · mac CC**: initial draft. Reframes postline from "agent residence" to "IM ↔ CC bridge". Doorbell v3 protocol spec preserved; router default and worker skill name revised. Story + README rewrites scoped as follow-on PRs.

# postline reframe · IM ↔ existing CC bridge

> Status: **FROZEN v3 · 2026-06-13** · Author: mac CC · Sole owner: mac CC
> Lifecycle: design → mac-self-review → C様 decisions on RF1-RF8 → **freeze (this rev)** → impl
> v3 ratifies the reframe retroactively: the Doorbell sprint (#42–#47) shipped under this frame, and the router code on `main` already implements every §3.2 revision (`reject_no_worker` default, `embeddedLlm` off-by-default toggle, `worker_aliases` keyed by repo+host, `cc-worker` naming). README + `project_postline_story.md` already carry the new framing. This freeze closes the self-review (§10), answers RFOQ1–4 (§8), and reconciles §7 sequencing with what actually shipped. Only PR-DB-6 (telegram) remains unbuilt.
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

## 7 · Sequencing — what actually shipped (reconciled v3)

The v2 forecast below was overtaken by events: the Doorbell sprint shipped faster than planned and `main` already carries the reframe. Recording actuals against forecast:

| Item | v2 forecast | Reality |
|---|---|---|
| Story doc rewrite (§4) | T+~1d | ✅ Done — `project_postline_story.md` reframed 2026-06-08 (总机/桥 metaphor, 公寓 chapters retired) |
| README rewrite (§5) | T+~1d | ✅ Done — H1 = "missing IM connector for Claude Code" |
| PR-DB-1 endpoints+queue+HMAC+long-poll | T+~3-4d | ✅ Shipped #42 (`b572ad1`) |
| PR-DB-2 router (reframe-revised) | T+~6d | ✅ Shipped #43 (`1c3efa3`) — `reject_no_worker` default, `worker_aliases`, host filter |
| PR-DB-3 cc-worker skill + headless runner | T+~8d | ✅ Shipped #44 (`59c15b6`) — already named `cc-worker`, not `mac-worker` |
| PR-DB-4 ETA + progress UX + status | T+~9d | ✅ Shipped #45 (`aa2be15`) |
| PR-DB-5 embedded_llm toggle | T+~10d | ✅ De-facto in `main` — `embeddedLlm` config (default false) wired through router `matcher.ts`; no separate PR needed |
| v0.5.0 release | T+~14d | ✅ Shipped #46 (`ef2e906`) + headless 中文 fix #47 (`6ad3da9`) |
| **PR-DB-6 telegram adapter** | T+~12d | ⬜ **Not built** — the only remaining roadmap item from this RFC |
| (a) Feishu push hook | T+~3h | ⬜ Not built — meta-tooling, separate track |

**Net**: the reframe is live in code and prose. This RFC froze *after* implementation rather than before — acceptable here because the product-axis decisions (RF1/2/5/6/7/8) were C様-locked up front and the engineering revisions (§3.2) were mechanical. v3 ratifies what shipped.

Remaining post-freeze work: PR-DB-6 (telegram), optional (a) Feishu push hook, RFOQ2 deferred-to-v0.6.0 default-worker preference.

---

## 8 · Open questions — RESOLVED (v3)

- (RFOQ1) **In-place upgrade. ✅ DECIDED.** `cc.service` ExecStart runs `postline feishu`; same command, bridge behaviour now governed by `embeddedLlm` config (default false). No separate `postline-bridge` binary. Zero migration cost for the one operator (C様). Marked BREAKING in the 0.5.0 changelog. *Operational note: the EC2 in-place flip (verifying `cc.service` runs with `embeddedLlm` off) is ec2 CC's physical domain per `protocol_cc_division.md` §1 — mac CC ships the code, ec2 CC owns the systemd cutover.*
- (RFOQ2) **Defer default-worker-per-repo to v0.6.0. ✅ DECIDED.** v0.5.0 ships autoroute on repo keyword + `!cc:repo@host` override. Persisted per-repo default worker preference is a v0.6.0 item.
- (RFOQ3) **Keep `ec2_self_solve` / `ec2_direct_answer` syntactically. ✅ DECIDED & SHIPPED.** `matcher.ts` keeps both rule kinds; they only fire when `embeddedLlmEnabled` is true, else the fallback is `reject_no_worker`. Lets users toggle modes without rewriting routing.md. (Verified in `packages/core/src/router/matcher.ts`.)
- (RFOQ4) **Telegram = bot-token only for v1. ✅ DECIDED.** Matches the feishu adapter's auth model. TDLib user-account login is out of scope for PR-DB-6; revisit only if a use case surfaces.

---

## 9 · Owner-shift (added v2)

ec2 CC stood down from postline implementation 2026-06-07 (mailbox handoff). Practical effects:

- All postline design + implementation work is mac CC sole-owner from now on.
- ec2 CC retains: cc.service bridge daemon process, mailbox layer 1-4, PR/issue watchers, openclaw heap watchdog, Feishu inbound routing.
- ec2 CC does **not**: open postline PRs, write postline plan docs, route postline work without explicit mailbox dispatch from mac CC.
- §3.1 / §3.2 of this RFC is now mac CC's self-review responsibility, not ec2 review.
- The original (a) Feishu push hook task (assigned to ec2 in `protocol_cc_mailbox.md`) is reassigned to mac CC. Implementation lives in postline-the-bridge (which still runs on ec2 via cc.service, but is built by mac CC).

This is not a rollback — it's a clarification of physical-domain ownership matching `protocol_cc_division.md` §1. ec2 CC's domain is operational infrastructure (systemd, watchers, routing); mac CC's domain is product features (postline, NeuGate). Bridging the two via mailbox protocol stays as-is.

## 10 · Self-review checklist (mac CC) — CLOSED v3

- [x] **Contradicts doorbell.md v3?** No. The router-fallback change + worker rename are the only deltas; both shipped cleanly in #43/#44 without touching the protocol layer (long-poll/HMAC/registry/queue all intact in #42).
- [x] **RF3 / RF4 the right open eng questions?** Yes — and both validated by shipped code. RF3 (any-host worker): `cc-worker` skill keys on `(host, cwd)`, no mac assumption. RF4 (doorbell compatible): protocol spec untouched, only router fallback + rename revised, exactly as predicted.
- [x] **PR-DB-5 / PR-DB-6 sized right?** PR-DB-5 collapsed into the router work (embedded_llm toggle is a config field + one matcher branch, not a standalone PR) — done. PR-DB-6 (telegram) is correctly one PR: new `@postline/adapters-telegram` package mirroring the feishu adapter shape.
- [x] **Story doc rewrite realistic?** Yes — done 2026-06-08. Chapter list compressed (公寓 chapters retired), not inflated.
- [x] **README rewrite catchier?** "Missing IM connector for Claude Code" is concrete and shipped. Less grandiose than "residence" but matches actual usage — the right trade.
- [x] **Pivot risk?** Resolved by C様 fiat (RF1/2/5/6/7/8 locked) + a year of dogfood evidence. Not throwing away framing for marginal clarity — the bridge frame is what the usage pattern actually is.
- [x] **Sequencing realistic?** Moot — it shipped *faster* than the ~14d forecast (see reconciled §7). PR-DB-1 HMAC/long-poll scope did not blow up.

**Freeze verdict**: all checklist items closed; reframe is live in code + prose; this RFC ratifies it. Mergeable.

## Changelog

- **v3 · 2026-06-13 · mac CC · FROZEN**: ratifies the reframe retroactively. Status → FROZEN. §7 sequencing rewritten as forecast-vs-actual table (PR-DB-1..5 + v0.5.0 all shipped #42–#47; only PR-DB-6 telegram remains). §8 RFOQ1–4 all resolved (in-place upgrade / defer default-worker to v0.6.0 / keep self_solve syntactically / telegram bot-token-only). §10 self-review checklist closed — every item validated against shipped code on `main`. Freeze verdict: mergeable.
- **v2 · 2026-06-07 · mac CC**: ec2 CC stand-down absorbed. RF1/RF2/RF5/RF6/RF7/RF8 declare-locked by C様 fiat; RF3/RF4 stay self-review. Owner-shift section (§9) added. Sequencing rewrite (§7): single-owner ~14d vs original ~7d. Reviewer-checklist consolidated to self-review only. (a) Feishu push hook reassigned from ec2 to mac.
- **v1 · 2026-06-07 · mac CC**: initial draft. Reframes postline from "agent residence" to "IM ↔ CC bridge". Doorbell v3 protocol spec preserved; router default and worker skill name revised. Story + README rewrites scoped as follow-on PRs.

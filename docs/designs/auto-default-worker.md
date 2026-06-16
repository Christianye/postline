# Auto-default-worker · RFC

> Status: **FROZEN v1 · 2026-06-16** · operator-approved: Model C. C1 shipped #60; C2 keeper shipped 2026-06-16 · Author: mac CC · Sole owner: mac CC
> Lifecycle: design → operator decisions (RFW1-RFW5) → freeze → impl
> Trigger: operator's standing ask — "there should be a default worker; if
> none, start one" (wake-prefix-redesign §8a carve-out, OQ4). Today a
> dispatch with no registered worker for the cwd replies `reject_no_worker`.

---

## 0 · The tension this RFC must resolve

The reframe locked **RF2: `cc.service` is a pure bridge daemon, no Claude
session** — "postline carries bytes between IM and CC; the CC does the
actual work" (postline-reframe §1.2, §6.1). A bridge that *spawns* a worker
on demand starts holding compute + process lifecycle — the exact thing RF2
moved away from.

So this RFC is not "add a spawn call". It's: **can we give the operator
"no worker → one appears" without the bridge becoming a compute owner?**
Three model families below (§2); they differ on *who holds the process* and
*whether RF2 bends*.

---

## 1 · Current behaviour (baseline)

```
IM msg → route → dispatch_to_mac, cwd resolved
  → registry.activeForCwd(cwd, selector)?
      yes → enqueue + dispatch to worker
      no  → reject_no_worker:
            "🤔 No worker for this request. Start a CC worker for the
             relevant repo, or enable embeddedLlm."
```

The operator then manually opens a terminal and runs `cc-worker start`.
The ask: collapse that manual step.

---

## 2 · Model families

### Model A — bridge spawns locally (breaks RF2)

The bridge process `spawn`s a headless `claude -p` / `codex exec` itself
when no worker exists, registers it as an ephemeral worker, dispatches.

- **Where**: on the bridge's own host (EC2 for the live deployment).
- **RF2**: **broken** — the bridge now runs compute. Would need RF2
  amended to "bridge MAY hold an ephemeral worker pool, opt-in".
- **Problems**: the bridge host needs the repo checked out + toolchain +
  creds (the whole reason workers live on the operator's machines). EC2
  doesn't have the operator's Mac repos. So local-spawn only helps when the
  bridge host *is* a useful work host — which contradicts the reframe's
  "work happens where the repo + tools are".
- **Verdict**: only coherent for a single-host self-hoster (bridge == work
  host). Wrong for the mac+ec2 split that motivated the reframe.

### Model B — bridge wakes a remote host (SSM / ssh), spawns there

Bridge holds a list of "spawnable hosts" (e.g. the Mac via SSM). On no
worker, it remotely launches `cc-worker start` on the host that owns the
repo.

- **Where**: the operator's real work host, woken on demand.
- **RF2**: **bent, not broken** — the bridge doesn't run the agent, but it
  does orchestrate process launch on another machine. "Carries bytes" → "also
  pokes a host to wake a worker".
- **Problems**: needs standing remote-exec creds (SSM/ssh) from bridge →
  every work host = big new attack surface + trust escalation. Host must be
  on + reachable. Which host owns which repo = config the bridge must hold.
- **Verdict**: powerful but heavy; the remote-exec trust is the sticking
  point. Essentially rebuilds a mini orchestrator.

### Model C — no bridge spawn; richer "start a worker" affordance (keeps RF2)  ⭐

Bridge never spawns. On no worker it replies with a **one-tap path to start
one on the right host**, instead of a flat reject. Variants:

- **C1 · deep-link / copy-paste**: the reject reply includes the exact
  command (`cc-worker start --agent cc` in the resolved cwd) + a note. The
  operator taps it on the host. Pure UX polish over today.
- **C2 · pre-armed launcher on the work host**: a tiny always-on agent on
  each work host (a `launchd`/systemd user service `cc-worker-keeper`) that
  the bridge can signal *through the doorbell itself* — e.g. the worker host
  runs a supervisor that (re)starts `cc-worker` when the bridge posts a
  "wake" the supervisor long-polls for. The **compute + lifecycle stays on
  the operator's host**; the bridge only emits a wake intent (still just
  bytes). RF2 intact.
- **C3 · queue-and-hold**: bridge enqueues the task (already supported) and
  the *next* time a worker for that cwd registers, it drains. Combined with
  C1/C2 the task isn't lost while the operator brings a worker up.

- **RF2**: **intact** — bridge emits bytes (a wake intent / a hint); the
  work host owns the process.
- **Verdict**: C2 + C3 is the reframe-faithful answer. The "keeper" is a
  per-host opt-in supervisor (the operator already runs *something* per host
  — this formalises it). Note: a `doorbell live deploy` keeper already
  exists for the mac headless path ([[reference_doorbell_live_deploy]]) —
  this generalises that pattern.

---

## 3 · Recommendation

**Model C (C2 + C3).** It's the only family that doesn't fight RF2:

- The bridge stays a pure byte-carrier; it gains a "wake intent" output, not
  a spawn.
- The per-host `cc-worker-keeper` supervisor owns process lifecycle, repo,
  tools, creds — exactly where the reframe says work belongs.
- Builds on the existing doorbell long-poll + the keeper already in the live
  mac deploy, rather than inventing remote-exec.
- Task isn't lost meanwhile (C3 queue-and-hold; the queue already persists
  in-memory until a worker drains it).

Model A is wrong for the mac+ec2 split. Model B's remote-exec trust is a
bigger security bill than the feature is worth right now.

---

## 4 · Decisions for the operator (RFW1-5)

- (RFW1) Family: **A (bridge spawns local) / B (remote wake) / C (keeper +
  queue-hold)**? Lean: **C**.
- (RFW2) If C: is the `cc-worker-keeper` per-host supervisor acceptable as a
  small new always-on component, or do you want to stay fully manual
  (C1 deep-link only — zero new daemon, just a better reject message)?
  Lean: **C1 first** (ship the better hint now, zero risk), **C2 keeper as a
  follow-on** once the wake-intent protocol is designed.
- (RFW3) Wake-intent transport: reuse the doorbell (`GET /watch`-style SSE,
  or a new `GET /wake` the keeper long-polls), or out-of-band? Lean: **reuse
  doorbell** — the keeper is just another authenticated long-poll client.
- (RFW4) Security: the keeper auto-starting a worker means an inbound IM
  message can cause a process to start on your machine. Gate on: the
  existing allowlist (only allowlisted senders' dispatches arm a wake) +
  the keeper only starts a worker for **repos on a per-host allowlist**
  (the keeper's own config), never an arbitrary cwd. Lean: **both gates**.
- (RFW5) Scope: is this v0.6.0 material, or parked until you actually feel
  the manual-start friction in daily use? Lean: **C1 now** (cheap), **defer
  C2/C3** until the friction is real.

---

## 5 · If C1-only (the cheap slice)

Just improve the `reject_no_worker` reply to be actionable:

```
🤔 No worker for `postline`. Start one on the host with the repo:
   cc-worker start              (Claude Code)
   cc-worker start --agent codex
Your task is queued (#a3f8) and will run as soon as a worker registers.
```

Requires: the queue-and-hold (C3) so the task survives until a worker comes
up (small: the task is already enqueued; today the reject path doesn't
enqueue — change it to enqueue + hold for the resolvable cwd). No new
daemon, no RF2 question. This alone might be enough.

---

## 6 · Self-review checklist

- [ ] Does C3 queue-and-hold risk unbounded queue growth if no worker ever
      comes? (Cap already exists per cwd: queueMax=10 → 429. Plus deadline
      expiry. Acceptable.)
- [ ] C2 keeper: does "IM message starts a process" need more than the two
      gates in RFW4? (Sandboxing of the spawned worker is the worker's own
      concern — codex `workspace-write`, cc's tool risk gate.)
- [ ] Is C1 actually different enough from today's reject to be worth it, or
      is today's "Start a CC worker" hint already enough? (C1's value is the
      queue-and-hold, not the wording.)
- [ ] Does any of this reopen RF2, and if so is that a deliberate operator
      decision (RFW1=A/B) rather than drift?

## Changelog

- **v1 · 2026-06-16 · mac CC**: initial RFC. Frames the RF2 tension (bridge
  = no compute vs auto-spawn). Three model families: A bridge-spawns-local
  (breaks RF2, wrong for mac+ec2), B remote-wake (bends RF2, heavy
  remote-exec trust), C keeper+queue-hold (RF2-intact, ⭐). Recommends C,
  with C1 (actionable reject + queue-hold, zero new daemon) shippable now
  and C2 keeper deferred. Awaiting operator RFW1-5.
```

# Doorbell · postline ↔ mac-CC remote interface

> Status: **Draft v3 · 2026-06-06** · Author: mac CC · Pending C様 final freeze
> Lifecycle: design → mac-self-review (done, 14 findings) → C様 R1-R5 (done) → ec2 review (done, 9 findings) → C様 transport pick (SSM, done) → **freeze pending** → PR-DB-1
> v3 changes vs v2: integrated ec2 CC's 9 findings. Transport locked to **SSM port forwarding** (B1). M1 (since=seq removed). M2 (detection rewrite). M3 (task↔workerId lock). M4 (active demote → 409 on hold poll). M5 (operator-initiated rotation). Plus 4 nits + 2 Q resolved.
>
> **What this is**: a feature design doc, not a sprint plan. Sprint plan
> (PR breakdown + acceptance criteria + work assignments) lives at the bottom
> of this doc and gets promoted to `docs/SPRINT_PLAN_DOORBELL.md` on freeze.

---

## 1 · Problem

postline runs 24/7 on EC2 and answers Feishu messages. C様 lives on a Mac
that he opens / closes throughout the day. Today the workflow looks like:

```
C様 (Feishu): "看一下 postline 的 routing 问题"
postline: <answers from memory + general knowledge,
           but cannot read the actual repo / run tests / edit code>
C様: <walks back to Mac, opens Claude Code, asks me directly>
```

**The Mac is where the work actually happens** — IDE, repo checkouts, build
toolchain, Docker, browser. The EC2 postline is where C様 always *is*
(Feishu is the omnipresent UI). Bridging the two manually is the friction.

We need a way for postline to **dispatch work to the Mac CC instance** when
the request needs the Mac, and report progress back to Feishu.

### What this doc is *not* solving

- Multi-user dispatch (only C様 owns both ends; no RBAC, no tenants).
- Mac-to-Mac (multiple Macs collaborating). One Mac is the assumption.
- Public exposure of postline (still no inbound HTTP from internet —
  `/mac/*` endpoints sit behind the same `restrict_inbound` posture as the
  approval-card webhook would, see §6).

---

## 2 · Ontology

postline has been positioned as **the AI agent's residence** in
`project_postline_story.md`. The metaphor extends naturally:

| Concept | Real thing |
|---|---|
| postline | Apartment building (long-lived, 24/7) |
| EC2 CC | Concierge living in the lobby (always there, knows everyone) |
| Mac CC | Resident in apt 4B (sometimes home, sometimes out) |
| Feishu | Front-door buzzer (how visitors reach anyone inside) |
| **Doorbell** | **The thing that lets the concierge ring apt 4B from the lobby** |

The Doorbell is **not another agent**. It is the protocol + transport that
lets the concierge (postline) reach the resident (mac CC) when the visitor
(C様 in Feishu) needs the resident specifically.

This matters for product positioning: when we tell strangers about postline,
"AI agent's residence" already differentiates from langchain / cursor / etc.
**Adding a remote interface that respects this ontology — instead of
flattening it into "RPC server" — keeps the story coherent.**

### Why "Doorbell" and not "Remote Interface"

- "Remote interface" describes the mechanism. "Doorbell" describes the
  intent. Doors are how strangers enter. Doorbells are how friends already
  inside reach each other.
- Continues the residence metaphor in story doc → marketing copy writes
  itself.
- Matches the natural latency contract: a doorbell rings, the resident
  answers when they're home. If they're out, the bell still rang
  (queued); they answer when they get back.

---

## 3 · Story positioning

Per `project_postline_story.md`, the Doorbell is **Chapter 3.5 · 门铃** —
inserted before Chapter 4 · 搬家.

**Why before 搬家**: Chapter 4's payoff is C様 telling 老张 "你也养一个吧"
and 老张 onboarding in 5 minutes. If 老张's first interaction is "I asked
my CC about my repo and it had no idea, then I had to walk back to my
laptop" — the demo fails. The Doorbell **is the mechanism that makes the
24/7 residence feel useful**, not just present.

Without the Doorbell:
- postline is a chatbot that happens to remember things.

With the Doorbell:
- postline is the **always-available frontdesk for an agent that lives on
  your machine**, with seamless handoff.

That's the story upgrade.

---

## 4 · Architecture

### 4.0 · Long-poll wire protocol (load-bearing)

The single most failure-prone primitive. Spec is explicit so worker
reconnect logic in PR-DB-3 cannot drift.

**Worker → postline**: `GET /mac/poll?workerId=<id>` with
`Authorization: Doorbell-HMAC <signature>`. Connection held open
**up to 30s** by postline.

No `since=<seq>` ack channel (per ec2 review M1): an explicit ack channel
duplicates the `dropped+requeue` mitigation in §7 row 1 and adds a per-task
state dimension we'd then need to spec carefully. The chosen design:
- postline only marks a queued task as "dispatched" once the long-poll
  HTTP response has been **fully written** to the socket. If the
  socket fails before write completion, postline retains the task in
  the queue.
- If the worker crashes after receiving the task but before posting
  any progress/result, `§7 row 1` (progress idle > task deadline)
  surfaces it as `dropped`, requeue counter ticks.
- A worker that re-registers with the same `workerId` mid-task is
  treated as evidence the previous task was lost (§7 row 1 alt).

**postline → worker** (3 cases):

| Case | HTTP | Body | Worker action |
|---|---|---|---|
| Task available | 200 | `{taskId, prompt, deadline_ms, ...}` | Run task, then immediately re-poll. |
| 30s elapsed, no task | 204 | empty | Reconnect immediately. Counts as a heartbeat. |
| Worker rejected (unknown id, bad HMAC, ts skew, standby and de-prioritised) | 401/403/409 | `{error}` | Exponential backoff reconnect via `/mac/register`. |
| postline down / 5xx / network drop | n/a | n/a | Exponential backoff: 1s → 2 → 5 → 10 → 30 (cap). |

**Why 204 not "200 + empty body"**: empty 200 is ambiguous (is it "no task,
keep polling" or "we sent you nothing because something's wrong"?). 204 is
unambiguously "long-poll cycle ended cleanly, reconnect now."

**Why exit on 30s rather than hold forever**: NAT idle timers, EC2 ALB
idle limits, transparent proxies. 30s is well under all known thresholds.

### 4.1 · High-level flow

```
            ┌──────────────────────────┐
            │   C様 (Feishu / mobile)  │
            └────────────┬─────────────┘
                         │ "@cc 看一下 postline 的 routing 问题"
                         ▼
        ┌──────────────────────────────────────┐
        │  postline (EC2 daemon, 24/7)         │
        │  ─ Lark.WSClient long-poll inbound  │
        │  ─ Router (memory/routing.md)        │
        │     ├─ simple → direct answer        │
        │     ├─ ec2-doable → builtin tools    │
        │     └─ mac-needed → Doorbell         │
        │  ─ Doorbell:                         │
        │     ├─ /mac/register  (POST)         │
        │     ├─ /mac/poll      (long-poll)    │
        │     ├─ /mac/progress  (POST)         │
        │     ├─ /mac/result    (POST)         │
        │     └─ Per-cwd worker registry +     │
        │       per-worker FIFO queue          │
        └────────────────────┬─────────────────┘
                             │ HTTPS (long-poll, 30s)
                             ▼
        ┌──────────────────────────────────────┐
        │  Mac CC (Claude Code, interactive)   │
        │  ─ skill: mac-worker                 │
        │     ├─ /mac-worker start             │
        │     │    spawns child node process   │
        │     │    that:                       │
        │     │     • POST /mac/register w/cwd │
        │     │     • long-poll /mac/poll      │
        │     │     • on task: spawn           │
        │     │       `claude -p <task>`       │
        │     │       headless                 │
        │     │     • forward stdout chunks    │
        │     │       → POST /mac/progress     │
        │     │     • on done → POST           │
        │     │       /mac/result              │
        │     ├─ /mac-worker stop              │
        │     └─ /mac-worker status            │
        └──────────────────────────────────────┘
```

### 4.2 · Sequence — happy path

```
C様 (Feishu): "@cc 改 postline 的 cmd-doctor 加 --json 输出"

postline:
  router.match(msg) → mac-needed (keyword: cmd-doctor, repo postline)
  workers.findByCwd("postline") → worker abc123 (last-poll 4s ago)
  taskId = "a3f8"
  workers[abc123].queue.push(task)
  long-poll resp to abc123 ← {taskId: "a3f8", prompt: "..."}
  Feishu reply (msgId M1): "🟡 #a3f8 dispatched to mac (cwd=postline)"

mac worker:
  spawn `claude -p "..."` headless
  stdout chunk: "<eta>45</eta>" → POST /mac/progress
                                    body: {taskId, eta: 45}
postline edits M1 → "🟡 #a3f8 running on mac · ETA 45s"

mac worker:
  stdout chunks of model response →
    POST /mac/progress (debounced 5s) {taskId, summary: "reading file..."}
postline edits M1 → "🟡 #a3f8 running · reading file..."

mac worker:
  exit 0, final stdout payload →
    POST /mac/result {taskId, status: "ok", text: "..."}
postline edits M1 → "🟢 #a3f8 done\n<full result>"
```

### 4.3 · Sequence — no worker available

```
C様 (Feishu): "@cc !mac:NeuGate 跑一下 lint"

postline:
  router → forced mac, repo=NeuGate
  workers.findByCwd("NeuGate") → none
  queue.push(task) under cwd=NeuGate, queueLen=1, max=10
  Feishu reply: "🟠 #a3f8 queued for mac (cwd=NeuGate). No active worker; will run when one starts. (1/10)"

[hours later]
C様 opens Claude Code in ~/Downloads/ClaudeCode/NeuGate, runs `/mac-worker start`.

mac worker:
  POST /mac/register {workerId, cwd: "NeuGate"}
postline:
  drains queue for cwd=NeuGate, pushes #a3f8 down the long-poll
  Feishu (proactive new msg): "🟡 #a3f8 picked up by mac (cwd=NeuGate)"
  ...
```

### 4.4 · cwd canonicalisation rule (load-bearing)

A worker registers with `cwd`. Two registrations with different surface
strings can refer to the same directory (`./postline` vs
`/Users/junye/Downloads/ClaudeCode/postline` vs `~/Downloads/.../postline`).

**Canonical form** is computed worker-side before the registration POST:

1. `git rev-parse --show-toplevel` if inside a git tree, else `process.cwd()`
2. `fs.realpathSync()` to resolve symlinks
3. POSIX-normalize separators
4. **Preserve case as-is.** macOS file systems are case-insensitive
   (HFS+/APFS default) so `/Users/...` and `/users/...` resolve to the
   same inode; postline does NOT normalise case so the audit log keeps
   what the worker actually reported.

postline-side: receives the already-canonical string and uses it as a key.
**No further normalisation server-side** — the worker is the authority on
"what cwd am I in," and any divergence is a bug to fix client-side, not
server-side.

### 4.5 · Sequence — multi-session same cwd

```
C様: opens 2 CC windows in ~/Downloads/ClaudeCode/postline.
  window 1 runs /mac-worker start → registers as worker W1, cwd=postline
  window 2 runs /mac-worker start → registers as worker W2, cwd=postline

postline registry:
  workers[postline] = [W1 (standby), W2 (active)]
  rule: latest registration wins; older ones move to standby.

C様 sends a Feishu task → routes to W2.
C様 closes window 2 → W2 long-poll dies, 60s heartbeat sweep removes W2.
postline promotes W1 (standby → active) automatically.
```

---

## 5 · Decisions table (locked)

| # | Decision | Choice | Rationale |
|---|---|---|---|
| D01 | Channel | HTTP long-poll over HTTPS | Simplest, debuggable, works through any NAT. Polling timeout 30s, worker reconnects. |
| D02 | Worker host process | Claude Code session (skill `mac-worker`) | Aligns with C様's mental model: CC is the resident. CC closed = resident out. |
| D03 | Worker registration key | `cwd` (workspace dir) | Maps to "which repo is this CC working on", which is what routing rules need. |
| D04 | Task ID | 4-char base16 (`a3f8`) for **human display**; postline-side authoritative key is `(feishuMessageId, taskSeq)` tuple | 4-char fits IM. Collisions across postline restarts are real but harmless: status queries use the Feishu message ID (always unique), and the 4-char only ever appears alongside it. v1 explicitly does **not** persist tasks across restart (§7.1), so cross-restart collision lookup is out of scope. |
| D05 | Multi-session same cwd | Latest registration wins. Older active worker → standby. **Standby auto-promotes synchronously** when the active worker is removed (heartbeat sweep, explicit stop, or registration-loss). If multiple standbys exist, **earliest-registered first** (FIFO) — matches "I started window 1, then window 2 stole the lock; if window 2 dies I want window 1 back" intuition. **Demotion-on-hold-poll** (per ec2 review M4): if a worker is demoted to standby while it has a long-poll connection open, postline closes that connection immediately with **HTTP 409 + body `{status: "demoted", reason: "another_worker_registered_for_cwd", newActiveWorkerId}`**. The worker's reconnect logic re-registers (now as standby) and waits for promotion. (Alternatives: 30s natural timeout / silent fd close — both leave the demoted worker blind to its own state for up to 30s.) **Task ↔ workerId lock** (per ec2 review M3): once a task's 200 dispatch response is fully written to a worker, the task is bound to that `workerId` until terminal status. Demotion does NOT revoke in-flight tasks. The demoted worker's `/mac/progress` and `/mac/result` POSTs are still accepted for tasks it owns. New tasks dispatched while demoted go to the active worker. | Prevents accidental dual-execution; gives deterministic test order; prevents in-flight task loss on demotion. |
| D06 | Worker shutdown | Explicit `/mac-worker stop` + 60s heartbeat sweep | Defense in depth. Heartbeat covers SIGKILL / OS crash / network partition. |
| D07 | No matching worker | Queue task; consume on first matching register. **Cap 10 default**; 11th rejected with HTTP 429 + body `{error: "queue_full", cwd, queueLen, queueMax, taskHint: "<first 80 chars of prompt>"}`. **Rejection does NOT consume a queue slot**; user retries after queue drains. **Feishu UX caveat**: when worker is offline, message reads "🟠 #a3f8 queued (will be lost if postline restarts)". When worker is active, "🟡 #a3f8 dispatched". | Transparency over false durability. v1 has no sqlite (§7.1); v2 may add it once we measure. |
| D08 | Force routing failure | Return error to user, don't fallback | `!mac:NeuGate` means NeuGate specifically; falling back to mac-postline would silently mis-execute. |
| D09 | Routing source | `memory/routing.md` with chokidar reload. **Reload is atomic**: postline parses to a new config object, validates, then swaps the pointer. Parse failure → log warning, **keep previous valid config**, never serve a half-loaded one. In-flight router calls use the snapshot they captured at request entry. | Live-editable, race-free. |
| D10 | Queue policy | **One FIFO queue per cwd, cap 10 shared** (per ec2 review N2). The same queue holds tasks waiting for an active worker (no-worker case in D07) AND tasks waiting their turn behind in-flight work on the active worker. Per-cwd separation prevents head-of-line blocking across repos; per-cwd consolidation avoids a "10 queued for no-worker + 10 queued for active = 20 effective" surprise. `config.doorbell.queueMax` controls the cap. | Single number for users to reason about. |
| D11 | ETA reporting | Headless mac CC emits `<eta>SECS</eta>` as first line if >30s expected | Standardised tag, easy parse, opt-in (silence = "fast enough not to bother"). |
| D12 | Progress UX | Edit one Feishu message in place | Avoids notification spam. Throttle 5s to stay under Feishu rate limits. |
| D13 | User overrides | Prefix `!mac` / `!mac:<repo>` / `!ec2` / `!plain` | Explicit, discoverable via `@cc help`. |
| D14 | Status query | `@cc status #a3f8` and `@cc workers` | First-class discoverability. |

---

## 6 · Transport + threat model

### 6.1 · Transport: SSM port forwarding (locked v3)

postline binds the 4 Doorbell endpoints to **`127.0.0.1:9999` only**.
**No public inbound port. No ALB. No EIP. No third-party reverse proxy.**
This preserves PR #34 sprint pack's "no inbound HTTP" stance.

The Mac reaches postline through **AWS SSM port forwarding**, which the
operator already uses for `openclaw-bridge` (see
`reference_openclaw_bridge.md` for the proven mac↔ec2 pattern):

```
mac:                                                ec2 (postline):
┌──────────────────────────────────┐                ┌──────────────┐
│ aws ssm start-session            │   SSM agent    │ 127.0.0.1:   │
│   --target <iid>                 │ ─────────────► │   9999       │
│   --document-name                │  (Midway SSO,  │              │
│     AWS-StartPortForwardingSession│   no public   │  4 endpoints │
│   --parameters portNumber=9999,  │   ingress)     │  (HMAC-auth) │
│     localPortNumber=9999         │                │              │
└──────────────────────────────────┘                └──────────────┘
            │
            ▼
   mac worker → http://localhost:9999
```

**Why SSM not Cloudflared / Tailscale**:

- Isengard does not allow public inbound; b2 (cloudflared) and b3
  (tailscale) both route ec2 traffic through a third-party reverse
  proxy → corp policy yellow flag.
- SSM is **isengard-native** (Midway SSO) — same auth surface the
  operator uses for daily ops; zero new dependency.
- Existing pattern in `reference_openclaw_bridge.md`. Mac CC already
  has SSM tunneling working for openclaw.
- Trade-off acknowledged: **mac CC closed = SSM session closed =
  doorbell unreachable**. This matches the product semantic ("CC closed
  = resident not home, no tasks dispatchable") cleanly. It is not a bug.

**Failure mode**: SSM sessions can idle-disconnect after extended inactivity.
Mitigation in PR-DB-3: mac worker wraps the SSM session in an
auto-restart supervisor (similar to autossh). Long-poll (§4.0) keeps the
TCP connection active inside SSM, so disconnect only happens between
polls.

### 6.2 · Trust model (explicit)

**Doorbell secret leak = full compromise.** That is the trust model. We do
not pretend otherwise:

- A secret holder can register any cwd, drain any queue, forge any result.
- Hostname / mac-address allowlists were considered in v1 and **rejected
  in v2** because they are forgeable in the same request that carries the
  secret — they are security theatre, not defence-in-depth.

What we *do* commit to:

- Secret is 32 bytes random, stored 0600 in `~/.cc-dev/.env` on both ends.
- HMAC over `(method, path, body, ts)` with 60s timestamp window prevents
  passive-replay across networks.
- **Secret rotation is operator-initiated** (v3 rule, per ec2 review M5).
  Triggers: suspected leak, key-compromise audit, or hostname-log
  anomaly per §6.3. postline does **not** auto-schedule rotation per
  release — that pace is unrealistic for a 1-operator deployment and
  would degrade into "the secret never gets rotated because it's painful
  to do so often." Rotation steps live in `deploy/docker/PREFLIGHT.md`
  (and equivalent for other deploy flavours). This aligns with
  `feedback_secret_hygiene.md` ("low-risk app secret 不主动 rotate, 真
  触发 leak 才 rotate").
- Workers log their `pid` + `hostname` for **audit only**, not for
  authentication. If the audit log shows a worker registering from a
  hostname C様 doesn't recognise, that's a signal the secret has leaked.

**Audit log surface** (per ec2 review Q2 resolution):

- Primary: postline structured log (pino → stdout → journalctl on EC2).
  Every register / poll-from-new-hostname / 4xx-rejected request gets a
  structured line with `event=doorbell_audit, kind=<...>, workerId,
  hostname, pid, cwd, ts`.
- Notification: Feishu DM to C様 **only when a hostname registers for
  the first time** (per-hostname dedupe, persisted in
  `~/.postline/state/known-hostnames.json`). Subsequent registrations
  from a known hostname log silently. Avoids notification fatigue while
  surfacing real anomalies (e.g., new hostname after a secret leak).

### 6.3 · Logged but not blocked

- Tasks routed to mac contain user prompts → mac CC sees them. Same as today
  when C様 types directly into Mac CC. No new exposure.
- **Headless mac CC inherits memory** (per OQ2 resolution): `~/.claude/`
  memory dir is read by the headless `claude -p` invocation, exactly like
  an interactive session. Same model, same system prompt, same
  working-style memory. Any divergence is a configuration bug.

### 6.4 · ec2 CC is NOT a doorbell client (per OQ4 resolution)

Only postline-the-bot may sign Doorbell requests. ec2 CC, when it acts as a
peer (e.g., responding to mailbox tasks), reaches mac CC through the
existing mailbox protocol (`inbox_mac.md`), not through Doorbell. This
preserves a clean separation: Doorbell is a bot↔resident channel, mailbox
is a peer↔peer channel.

---

## 7 · Failure modes

| Mode | Detection | Response |
|---|---|---|
| Mac task in flight dies | Detected via **two independent signals** (per ec2 review M2): (a) progress / result idle > task deadline (default 5min); (b) the same `workerId` re-registers mid-task — strong evidence the previous worker process died and respawned. Either trips. (Note: long-poll socket close at task dispatch is **not** a signal — the worker closes its own poll the instant it receives a task, then re-polls.) | Mark task `dropped`, **requeue automatically up to 2 times**. Feishu seed message progression: `🟡 running` → `🟠 dropped, retry 1/2` → on successful re-pickup **edits back to 🟡 running** (replays last known ETA + summary). Final failure after 2 retries: `🔴 #a3f8 failed after 2 retries`. Color rollback prevents the "saw 🟠 then succeeded but message stuck on 🟠" inconsistency reviewer flagged. |
| Worker registers but never polls | 60s heartbeat sweep | Unregister, drain its queue back to "no worker for cwd=X" state. **Acceptance test for PR-DB-1 explicitly covers this**: register, suppress polls for 65s, assert worker removed and queued tasks reverted. |
| postline restart while task in flight | Worker long-poll 502 | Worker retry-loop with exponential backoff; on reconnect, re-register. **In-flight tasks: lost.** This is acceptable in v1 because the Feishu UX is upfront about it (D07: queued tasks read "will be lost if postline restarts"). v2 reconsiders sqlite once we measure restart frequency. **Tasks containing destructive verbs (`deploy`, `rm -rf`, `force push`, `drop table`) are rejected at routing if no active worker exists** — they refuse to enter the lossy queue at all. |
| Headless `claude -p` hangs forever | Worker-side timeout (configurable, default 5min) | SIGTERM child, POST /mac/result `status:timeout` |
| Multiple workers race-register same cwd in same 100ms | postline serializes via mutex, latest wins | Loser worker gets 409 + standby flag |
| postline parses malformed routing.md | Schema validator fails on reload | Log warning, **keep previous config**. Send a one-time Feishu DM to C様: "🟡 routing.md reload skipped: <reason>". Never use a half-parsed config. |

### 7.1 · Persistence trade-off (intentional)

postline does **not** persist queued tasks across restart in v1. The
trade-off is real and called out so users aren't surprised:

- Postline restart is rare (release cadence ~weekly).
- In-flight tasks that survive a restart get `🔴 #a3f8 lost` Feishu edit;
  C様 retypes.
- Queued-but-not-yet-dispatched tasks: Feishu seed message **already says
  "will be lost if postline restarts"** at queue time (D07), so loss is
  expected, not surprising.
- Destructive tasks (verbs: `deploy`, `rm -rf`, `force push`, `drop`) are
  refused at routing time when no active worker exists — they cannot enter
  the lossy queue path.
- Persistence adds a sqlite dependency we don't otherwise need. v2
  reconsiders once restart frequency or actual loss-event rate is measured.

This is an explicit promise/spec gap closure: v1 says "best effort, told
you so"; v2 may say "durable."

---

## 8 · routing.md draft

This file lives at `<memory-dir>/routing.md` (i.e., the user's memory dir,
not the repo). On postline boot it's parsed; chokidar reloads it on edit
with the atomic-swap rule from D09.

### Precedence (resolves ambiguous keywords)

Evaluated top-down; first matching tier decides the route. **Within a tier,
earliest-matching keyword wins** (so order in the file is meaningful).

1. **Override prefixes** (`!mac`, `!mac:<repo>`, `!ec2`, `!plain`) — always win.
2. **Exact project name** in user message (`postline`, `NeuGate`, `openclaw`)
   — wins over generic verbs. e.g. "review postline 的 routing" → mac
   (project beats `review`); "review the diff" → ec2 (no project anchor).
3. **Path-tokens / file-extension hits** — strong signal of "this is on a
   filesystem", routes mac.
4. **Repo / toolchain verbs** (git, pnpm, IDE) — mac.
5. **Explicit verbs** (`看代码`, `改`, `跑测试`) — mac.
6. **ec2_self_solve triggers** — postline uses builtin tools.
7. **ec2_direct_answer triggers** — postline answers from model + memory.
8. **Fallback** — `ec2_self_solve`.

### File body

```markdown
# Postline Routing Rules

> Override prefixes win over everything below:
>   !mac           - force dispatch to default mac worker
>   !mac:<repo>    - force dispatch to worker matching cwd alias
>   !ec2           - force ec2 self-solve (use builtin tools)
>   !plain         - force ec2 direct-answer (no tools)

## projects (highest non-override precedence)
- postline       (postline doc-only edits → ec2_self_solve)
- NeuGate
- openclaw
- claude-memory

## dispatch_to_mac (path / toolchain / verbs)
- path token: ~/, /Users/, ./, *.ts, *.py, *.go, *.md, *.tsx, *.rs
- repo verbs: repo, branch, commit, "PR #", merge, rebase, git
- toolchain: pnpm, npm, vitest, biome, claude code, IDE, vscode, cursor
- explicit verbs: 看代码, 改, 写代码, review, debug, 跑测试, build, 重构

## ec2_self_solve  (postline uses builtin tools to answer)
- web_fetch: 查 docs, 搜, http(s)://...
- github remote queries: read PR/issue without checkout
- lark_docs: 飞书云盘
- memory queries WITHOUT mac-specific anchor: 我之前说过, 记得, 上次, 当时
  (queries with mac-specific anchor — paths, repo cwd, "上次跑 lint",
  "你那次改 ws-state" — go to dispatch_to_mac instead)
- cross-CC dispatch: 通知 ec2 CC, 通知 mac CC, mailbox

## ec2_direct_answer  (model + memory only, no tools)
- chitchat / greetings
- concept questions: 什么是, 解释, 区别
- math / translation / unit conversion
- short factual lookups (>200 chars expected response → fallback to self_solve)

## destructive_verbs (refuse-when-no-worker, per §7 row 3)
- deploy, "rm -rf", "force push", "drop table", "git push --force"

## cwd_aliases (which workers serve which keywords)
postline      → /users/junye/Downloads/ClaudeCode/postline
NeuGate       → /users/junye/Downloads/ClaudeCode/NeuGate
claude-memory → /users/junye/.claude/projects/-Users-junye/memory
```

Note `cwd_aliases` values are post-canonicalisation (§4.4): symlinks
resolved, POSIX separators. The lookup is done against the worker's
already-canonicalised `cwd`.

---

## 9 · Sprint plan (will move to docs/SPRINT_PLAN_DOORBELL.md on freeze)

### PR-DB-1 · postline endpoints + queue + task ID  (ec2-doable; ~2 days)

- New package: `packages/doorbell/` (HTTP server, registry, queue, hmac)
- Mounted into `cmd-feishu` start-up path (binds 127.0.0.1; tunneled or
  NATted for the Mac to reach — exact transport configured per deployment)
- Endpoints: `/mac/register`, `/mac/poll`, `/mac/progress`, `/mac/result`
- Long-poll wire protocol per §4.0 (200 task / 204 idle / 4xx errors)
- HMAC auth via `DOORBELL_SECRET`; 60s timestamp window
- Per-worker FIFO queue, cap 10 (`config.doorbell.queueMax`)
- Heartbeat sweep timer (60s)
- Standby promotion engine per D05 (FIFO over standbys when active dies)
- Acceptance:
  - integration tests with a mock worker: register, long-poll, receive a
    task, post progress, post result
  - multi-session race test (per ec2 review N4): register W1, W2, W3,
    W4, W5 in order; assert W5 is active, W1-W4 are standby. Kill W5;
    assert W1 (earliest standby) auto-promotes to active. Kill W1;
    assert W2 promotes. Continue until all dead; assert empty registry.
  - **heartbeat sweep test** (per F12 reviewer): register worker, suppress
    polls for 65s, assert worker auto-removed and pending tasks moved
    back to "no-worker queue" state
  - long-poll wire protocol test: assert 204 on 30s idle, 200+payload on
    queued task, 401 on bad HMAC, 403 on ts-skew, 409 on standby-poll
  - queue-cap test: push 10 tasks, assert 11th gets HTTP 429 with body
    matching D07 spec; rejection does not consume a slot
  - **demote-on-hold-poll test** (per ec2 review M4): W1 active with
    long-poll connection open; register W2 same cwd; assert W1's poll
    closes immediately with HTTP 409 + body
    `{status: "demoted", reason: "another_worker_registered_for_cwd",
    newActiveWorkerId: "W2"}`
  - **task↔workerId lock test** (per ec2 review M3): W1 active, dispatch
    `#a3f8` to W1; while W1 is running, register W2 (W1 demotes); W1
    posts progress, then result for `#a3f8`; assert postline accepts
    both POSTs and the task ends in `done` state owned by W1; assert
    new tasks dispatched during this window go to W2, not W1

### PR-DB-2 · routing.md loader + dispatch flow  (ec2-doable; ~2 days, **concurrent with PR-DB-1**)

Per ec2 review Q1 resolution: PR-DB-1 and PR-DB-2 develop in parallel.
PR-DB-2 unit-tests against a `MockDoorbellClient` (in-memory) so the
router logic and parser don't block on PR-DB-1 endpoints landing.
End-to-end integration of router → real Doorbell client → mac worker
moves to PR-DB-3 acceptance.

- `packages/postline-core/src/router/` parser + matcher
- chokidar watch with **atomic-swap** debounced reload (per D09): parse
  to new config object, validate, swap pointer; never serve a half-loaded
  config. Parse failure logs warning + Feishu DM (per §7 last row),
  keeps previous valid config.
- Hook into the Feishu turn dispatcher BEFORE provider call
- `dispatch_to_mac` path → calls **DoorbellClient interface** (real impl
  in PR-DB-1, mock in PR-DB-2 tests), edits a Feishu seed message
- `ec2_self_solve` / `ec2_direct_answer` paths → existing turn runner
  with varied tool surface
- Override prefix parser (`!mac` / `!mac:<repo>` / `!ec2` / `!plain`)
- Acceptance:
  - 30+ table-driven router tests against `MockDoorbellClient`
    covering precedence (override > project > path > toolchain >
    explicit-verbs > self-solve > direct-answer > fallback)
  - live `routing.md` reload test (chokidar edit → next message uses
    new rules without restart)
  - destructive-verb pre-routing refusal test (per §7 row 3): inject
    `deploy postline now` with no active worker; assert task is
    refused with explicit Feishu reply, **not queued**

### PR-DB-3 · mac skill + worker process + headless runner  (mac-only; ~2 days)

- New skill `mac-worker` under `~/.claude/skills/mac-worker/`
- Three subcommands: `start`, `stop`, `status`
- Worker = small node script `mac-worker.js`:
  - reads `DOORBELL_SECRET` from env
  - canonicalises cwd per §4.4 (git toplevel → realpath → POSIX-normalise)
  - posts `/mac/register` with hostname, canonical cwd, pid
  - long-poll loop per §4.0 (30s timeout, exponential reconnect backoff
    on errors / 5xx / network drop; 1s→2→5→10→30 cap)
  - on 200 task → spawn `claude -p <task>` (see headless invariants below)
  - stdout pipe → POST `/mac/progress` debounced 5s
  - on exit → POST `/mac/result`
- Status file at `~/.postline/state/mac-worker-<cwd-hash>.json` (pid, registered_at)

**Headless invariants** (per OQ2 resolution + F8 + F13):

- Same model as the active CC session (read from same `model:` config; do
  not downgrade). Any divergence is a config bug.
- Same system prompt + same memory dir (inherits `~/.claude/memory/...`)
  so the headless task behaves like an interactive C様↔CC turn.
- Same working-style ("先方案后代码 / dangerous 动作先声明 / 中文回复"
  per CLAUDE.md), pulled from memory.
- The headless prompt prepends a fixed preamble: "You are running headless
  on behalf of postline-the-bot. If you predict total runtime > 30s, emit
  exactly `<eta>SECS</eta>` on a line by itself before any tool calls.
  Else emit nothing for the ETA tag."

Acceptance:
- Round-trip from `start` to receiving a real task to result on Feishu
- Manual kill of `claude -p` (via `kill -TERM <pid>`) triggers
  `status:killed` to postline
- Multi-session start (two `start` invocations same cwd) → second wins,
  first transitions standby; assert via `/mac-worker status`
- Headless invariants test: take a small fixture task, verify model id,
  system prompt prefix, and memory access in the spawned process

### PR-DB-4 · ETA + progress UX + status query + workers query  (both; ~1 day, depends PR-DB-1+3)

- Headless mac prompt template (per PR-DB-3 invariants) instructs the
  model to emit `<eta>SECS</eta>` only when >30s expected.
- **postline ETA parser is strict** (per F14 reviewer):
  - regex anchored: `^\s*<eta>(\d+)<\/eta>\s*$`
  - applies only to lines emitted **before any tool invocation** in the
    progress stream
  - inline matches (e.g. inside a code block) are ignored
  - reject and log a warning if `SECS` is non-numeric or > 3600 (1h cap)
- Progress edits at most every 5s (Feishu rate limit guardrail)
- New builtin tool `doorbell_status` exposed as `@cc status #a3f8` —
  status query uses the **Feishu message id** as the lookup key (per D04
  taskId duality), with the 4-char id only as a UX hint
- New builtin tool `doorbell_workers` exposed as `@cc workers`
- Acceptance:
  - live test: dispatch a 60s task, observe Feishu seed message edit
    through ETA → progress → done
  - `@cc workers` lists active + standby workers per cwd, ordered by
    activeness then registered_at
  - ETA parser unit tests: alone-on-line accepted, inline rejected,
    non-numeric rejected, >3600 rejected
  - retry color rollback test (per F9): force a `dropped` mid-task,
    assert Feishu edit goes 🟡→🟠→🟡 on re-pickup → 🟢 on done

### Total: ~7 working days.

PR-DB-1 and PR-DB-2 run concurrently against the **DoorbellClient
interface** contract — PR-DB-2 tests use a `MockDoorbellClient`, PR-DB-1
ships the real one. PR-DB-3 needs PR-DB-1 endpoints live to test the
real worker path; cannot start until PR-DB-1 is at least feature-complete.
PR-DB-4 ties everything end-to-end.

---

## 10 · Out of scope (Phase 2+)

- **Encrypted tunnel**: HMAC over TLS is fine for v1. SSH reverse tunnel
  reconsidered if shared-secret rotation becomes painful.
- **Mac-to-Mac**: multiple Macs (laptop + desktop). Shape will be
  worker-set semantics — Phase 2.
- **Web UI for status**: a `/status` page replacing `@cc workers`.
- **Persistent task queue across postline restarts**: sqlite, eval after
  measuring restart frequency.
- **Cross-CC task chains**: mac CC dispatches sub-task back to ec2 CC.
  Possible with current primitives but adds dependency tracking.
- **Approval cards for dangerous mac tasks**: a mac task with
  `--dangerous` flag could route through the existing approval-card flow
  before headless execution. Defer until threat-model in §6 is exercised.

---

## 11 · Open questions

### Resolved

- ~~OQ2~~ (v2) → **inherit memory** (per C様 R4). Headless mac CC reads
  the same `~/.claude/memory` and uses the same model + system prompt
  as interactive sessions. Bot↔resident bridge presents one CC, not two.
- ~~OQ4~~ (v2) → **ec2 CC is NOT a doorbell client** (per C様 R5). Only
  postline-the-bot may sign Doorbell requests. Peer↔peer between CCs
  goes through the existing mailbox protocol.
- ~~B1 (transport)~~ (v3) → **SSM port forwarding** (per C様 v3 pick).
  127.0.0.1:9999 only on EC2; isengard-native; no public ingress.

### Still open (defer to v2 of doorbell or post-ship)

- (OQ1) Is HMAC + shared secret enough, or do we want an OIDC-style
  short-lived token issued by postline on every `/mac/register`? **v1
  ships with shared secret + 60s timestamp window**; OQ1 reopens if we
  hit a real rotation pain point.
- (OQ3) `claude -p` headless cost per task: budget cap per Feishu thread,
  or report-only? Current postline already tracks usage via `usage.jsonl` —
  reuse that surface. **v1 = report-only**; budget caps deferred until we
  have data on actual per-task cost.

---

## Review checklist (for C様 final freeze)

C様: v3 incorporates all of ec2 CC's 9 findings + your B1 SSM pick. Once
you ack this checklist, doc freezes and PR-DB-1 + PR-DB-2 open in
parallel.

- [ ] Transport (§6.1 SSM port forwarding) — final-state diagram matches
      what you'd actually run
- [ ] D05 demote-on-hold-poll + task↔workerId lock — semantics match
      your "if I open a new CC window same repo, the old one's task
      should still finish" intuition
- [ ] §6.2 audit log surface — postline log + Feishu DM on first hostname
      sighting is the right notification cadence
- [ ] §7 detection signals — progress idle + workerId re-register is
      enough; no other failure mode you'd want detected
- [ ] §10 out-of-scope — anything in there should actually be in v1
- [ ] OQ1 / OQ3 — happy with deferring or want one in v1

## Changelog

- **v3 · 2026-06-06 · mac CC**: integrated ec2 CC's 9 findings + B1 SSM
  pick. New §6.1 (SSM port forwarding transport, replaces vague v2 "or
  shared secret" wording). M1 (since=seq removed from §4.0). M2 (§7 row
  1 detection rewritten: progress idle + workerId re-register, NOT poll
  socket close). M3 (D05 + acceptance test: task↔workerId lock through
  demotion). M4 (D05 + acceptance test: demoted worker's hold-poll
  closed with HTTP 409 + status: demoted). M5 (§6.2: secret rotation
  operator-initiated, not per-release). N1-N4 spec-tightenings. Q1
  (PR-DB-2 unit-tests against MockDoorbellClient → real concurrency
  with PR-DB-1). Q2 (audit log = postline structured log + Feishu DM
  on first hostname sighting).
- **v2 · 2026-06-06 · mac CC**: integrated 14 findings from self-review.
  D04 (taskId duality), D05 (standby FIFO), D07 (queue transparency +
  Feishu UX caveat + 429 spec), D09 (atomic swap), §4.0 (long-poll wire
  protocol), §4.4 (cwd canonicalisation), §6 (HMAC trust model;
  hostname allowlist removed; OQ2 + OQ4 resolved into §6.3 / §6.4),
  §7 (retry color rollback; destructive-verb refusal; routing.md
  parse-failure handling), §8 (precedence rules; mac_allowlist removed),
  §9 (heartbeat sweep test, headless invariants, ETA strict parser).
- **v1 · 2026-06-06 · mac CC**: initial draft.

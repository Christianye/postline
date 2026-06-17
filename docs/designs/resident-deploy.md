# Resident deployment · config-driven always-on bridges + keeper

> Status: **FROZEN v1 · 2026-06-17** · operator-approved: Layer A, telegram on mac, keeper resident, resident.toml, deploy/ template + ~/.postline rendered · Author: mac CC · Sole owner: mac CC
> Lifecycle: design → operator decisions (RFD1-RFD5) → freeze → impl
> Trigger: operator wants the IM bridges + the auto-worker keeper to run
> always-on, **config-driven** (default telegram + lark, user can add
> others), not hand-started front-of-terminal processes.

---

## 0 · What exists today (ground truth)

```
feishu/lark (LIVE):
  飞书 → EC2 cc.service (bridge + doorbell:9999) → SSM tunnel → mac:9999
       → mac cc-worker (LaunchAgent com.cc.doorbell-worker) → claude -p
  · bridge on EC2 (systemd cc.service, ExecStart=… bin.js feishu)  [ec2 domain]
  · mac runs only: tunnel-keeper + worker-launcher LaunchAgents      [mac domain]

telegram / slack: verified live but hand-started (node … bin.js telegram).
  No resident process. doorbell on 9998 (local), worker local.

keeper (cc-worker keeper): built (#61), never made resident.
```

Each IM is its own process: `postline feishu | telegram | slack`. A channel
is "enabled" by having its config block present. **There is no single
process that runs multiple channels, and no config that says which
channels to bring up.** `cc.service` hardcodes `feishu`.

---

## 1 · The operator's ask, restated

"Resident bridges should be a **config item**, default `telegram + lark`,
user can add others." So: one place declares the set of channels, and the
deployment brings them up + keeps them alive, plus the keeper.

Two layers can deliver this — they're not exclusive:

### Layer A — deployment-only (no postline code change)

A generator script reads a small per-host deploy config (`channels:
[telegram, feishu]`, doorbell ports, keeper repos) and renders + loads one
LaunchAgent (mac) / systemd unit (EC2) per channel + one for the keeper.
Pure ops; lives in `deploy/` + `~/.postline/` (not the public package's
runtime). Fastest; matches how feishu live already works (per-purpose
LaunchAgents).

### Layer B — code: a `postline serve` multi-channel command

`postline serve` reads `config.channels` (or infers from which blocks are
set) and starts every enabled bridge **in one process**, sharing one
doorbell. One LaunchAgent/unit runs everything. More "product"; but a
shared doorbell across channels changes the current "one bridge = one
doorbell" model, and a crash takes down all channels.

**Lean: A now, B later (maybe never).** Layer A delivers the operator's
ask (config-driven resident set) with zero code risk + matches the proven
feishu pattern. Layer B is a product nicety that can wait until there's a
reason to co-locate channels in one process.

---

## 2 · Where each bridge runs (the cross-domain question)

| Channel | Bridge host | Why | Domain |
|---|---|---|---|
| feishu/lark | **EC2** (exists) | already live; 24/7; `cc.service` | ec2 (systemd) |
| telegram | **? — RFD2** | long-poll, no inbound port; mac or EC2 both work | depends |
| slack | (later) | Socket Mode, no inbound port | depends |

**The catch (physical-domain ownership):** systemd / EC2 is the infra-side
instance's domain; mac LaunchAgents are the feature-side instance's. So:
- A telegram bridge **on mac** = the feature-side instance does it directly via LaunchAgent.
- A telegram bridge **on EC2** = the infra-side instance's job, dispatched over the
  mailbox; the feature-side instance doesn't touch EC2 systemd.

Trade-off: mac bridge = simplest for me to build, but **dies when the Mac
sleeps/closes** (telegram unreachable). EC2 bridge = true 24/7 but
cross-domain + needs the worker reachable from EC2 (the repo lives on mac,
so EC2 bridge still dispatches to a mac worker over the tunnel — same shape
as feishu).

---

## 3 · The resident set, concretely (Layer A)

Per-host, a deploy config lists what to keep alive. Proposed default:

```
# ~/.postline/resident.toml  (or just env in the launcher scripts)
channels = ["telegram"]      # mac-side residents (lark bridge is on EC2)
keeper   = { repos = ["~/code/postline"] }
```

Generates LaunchAgents:
- `com.cc.postline-telegram` → `node … bin.js telegram` (doorbell 9998)
- `com.cc.postline-keeper` → `node … bin.js cc-worker keeper --repo …`
  (subscribes to the 9998 doorbell's `/watch`)

lark stays as-is (EC2 bridge + existing mac worker/tunnel LaunchAgents).

**Port map** (no collisions): feishu live tunnel = 9999, telegram bridge =
9998, slack (if added) = 9997. Each resident bridge owns its doorbell; the
keeper attaches to the one whose workers it manages.

---

## 4 · Decisions for the operator (RFD1-5)

- (RFD1) Layer **A (deploy-only generator)** vs **B (`postline serve`
  multi-channel)**? Lean: **A now**.
- (RFD2) telegram bridge on **mac (LaunchAgent, I build it)** vs **EC2
  (systemd, ec2 CC builds it via mailbox)**? Trade-off = simplicity vs
  24/7. Lean: **mac first** (prove the resident pattern end-to-end where I
  can iterate), promote to EC2 later if Mac-sleep gaps annoy you.
- (RFD3) Keeper resident too, or bridges only for now? Lean: **yes, keeper
  resident** — it's the whole point (no-worker → auto-start). Repos =
  whatever you `@pl` regularly.
- (RFD4) Config format: a `~/.postline/resident.toml` the generator reads,
  or just hand-edit the launcher scripts' env? Lean: **a tiny resident
  config** the generator consumes (matches "config item" ask), but
  implemented as Layer-A ops, not postline-core config.
- (RFD5) Does this go in the public repo (`deploy/` templates) or stay
  mac-local (`~/.postline/`, like the feishu keeper)? Lean: **generic
  template in `deploy/` + the rendered host-specific files in
  `~/.postline/`** — the pattern is reusable (a self-hoster wants it), the
  filled-in tokens/paths are local.

---

## 5 · Sketch of Layer A (if approved)

```
deploy/launchd/                      (public, generic)
  postline-bridge.plist.template     {{LABEL}} {{CHANNEL}} {{NODE}} {{REPO}} {{ENVFILE}}
  postline-keeper.plist.template     {{REPOS}}
  install-resident.sh                reads resident.toml → renders → launchctl load

~/.postline/resident.toml            (local) channels + keeper repos
~/.postline/secret, ~/.cc-dev/.env   (local) tokens
~/Library/LaunchAgents/
  com.cc.postline-telegram.plist     (rendered)
  com.cc.postline-keeper.plist       (rendered)
```

Each plist: `KeepAlive=true` (auto-restart), `RunAtLoad=true`, env from the
`.env` file, stdout/err to `~/.postline/<label>.log`. Mirrors the existing
`com.cc.doorbell-worker` shape exactly.

---

## 6 · Risks / open

- Mac-sleep gap (RFD2 mac choice): telegram unreachable while Mac sleeps.
  Acceptable for personal use; EC2 promotion fixes it.
- pkill foot-gun (learned 2026-06-16): `pkill -f cc-worker start` reaps the
  feishu-live worker too. The resident scripts must use **labelled
  launchctl** (`launchctl kickstart -k com.cc.postline-telegram`), never
  broad pkill.
- Shared 9998 doorbell: telegram bridge + keeper both attach. If slack also
  goes mac-resident it needs its own port (9997) + its own keeper attach.
- One keeper per doorbell: a keeper attaches to one bridge's `/watch`. Two
  mac bridges (telegram+slack) = two keepers, or one keeper per doorbell.

## Changelog

- **v1 · 2026-06-17 · mac CC**: initial. Two layers (A deploy-generator / B
  `postline serve`); lean A-now. Cross-domain map (lark=EC2 exists,
  telegram=mac-vs-EC2 RFD2). Resident set via a small `resident.toml` +
  rendered LaunchAgents mirroring the live feishu worker. Awaiting RFD1-5.
```

---
'@postline/adapters-cli': minor
---

feat(deploy): resident LaunchAgents (config-driven bridges + keeper) + keeper hardening

Resident-deployment story (docs/designs/resident-deploy.md, Layer A) — keep
the IM bridges + the auto-worker keeper alive across reboots, config-driven.

deploy/launchd/ (new, generic templates for the public repo):
- postline-bridge.plist.template / postline-keeper.plist.template
  (KeepAlive + RunAtLoad LaunchAgents).
- install-resident.sh — reads a resident config (RESIDENT_CHANNELS,
  KEEPER_REPOS, …), renders launcher scripts + plists, loads them.
- resident.conf.example.

Keeper hardening — five bugs caught dogfooding the resident keeper (all
"ships fine, only breaks when actually long-running"):
- SSE `/watch` long-poll gets `terminated` / the bridge may be down at boot
  → wrap in a reconnect loop with backoff (was: keeper exited → launchd
  thrash-restart).
- worker spawn `error` (ENOENT) was unhandled → killed the keeper → add
  `child.on('error')` that drops the slot + keeps running.
- spawned `postline` not on PATH → keeper now spawns `process.execPath`
  (node) + the running bin.js via the new `cliPrefixArgs` option.
- (deploy) launcher PATH must include `~/.local/bin` (claude) and set
  `CLAUDE_CODE_USE_BEDROCK` — documented; the worker inherits them from the
  sourced env file.

End-to-end verified live: telegram `!pl@<repo>` with no worker → bridge
wake → resident keeper auto-starts a worker → task drains → done, fully
hands-off. 725 tests (keeper +7: reconnect, spawn-failure survival).

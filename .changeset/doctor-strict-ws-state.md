---
'@postline/adapters-feishu': minor
'@postline/cli': minor
---

feat(doctor): add `--strict` flag with feishu WS liveness probe

`postline doctor --strict` now fails (exit 1) when the feishu adapter has
not produced a liveness tick within 90s. The adapter writes a tick on
every dispatched event and from a 30s keep-alive timer driven by the
`Lark.WSClient` connection-state callbacks (`onReady`, `onReconnected`,
paused on `onError`/`onReconnecting`). Missing tick is `warn` in lenient
mode.

The container Dockerfile and compose template both switch their
HEALTHCHECK to `doctor --strict`, with `start_period: 120s` to absorb
ws handshake time on cold boot. State dir defaults to `~/.postline/state`
(host) or `/data/state` (container), overridable via `CC_STATE_DIR`.

New exports from `@postline/adapters-feishu`:

- `writeFeishuWsTick`, `readFeishuWsTick`
- `resolveStateDir`, `resolveFeishuWsTickPath`
- `FEISHU_WS_TICK_FILENAME`, `FeishuWsTick`

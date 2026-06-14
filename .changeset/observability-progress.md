---
'@postline/doorbell': minor
'@postline/adapters-cli': minor
---

feat(observability): live structured progress from stream-json (PR-OBS-1)

The cc-worker now spawns headless Claude with `--output-format stream-json
--verbose` and parses the event stream, so the IM reply shows a live activity
feed instead of a tail-of-stdout snapshot:

```
🟡 cc@postline · mac · #a3f8 running · ETA ~25s
🔧 Bash: git show --stat
🔧 Read: matcher.ts
The diff looks fine.
🟢 cc@postline · mac · #a3f8 done
```

- New `ProgressEvent { kind: 'init'|'tool'|'thinking'|'text', label }` on the
  progress protocol (doorbell types + `/mac/progress`), validated at the trust
  boundary. Free-text `summary` stays as the fallback for agents without a
  structured stream (e.g. a future codex-worker).
- Final result text now comes from the authoritative `result` event.
- `💭 thinking` is off by default (elided single line when
  `CC_WORKER_SHOW_THINKING=1`).
- Tool boundaries flush an eager progress edit; the bridge keeps a rolling
  activity log per task.

This is the narrow-waist progress format that telegram / slack adapters and the
upcoming `cc-worker watch` TUI all render — build once, every IM × agent
inherits it. See `docs/designs/observability.md`.

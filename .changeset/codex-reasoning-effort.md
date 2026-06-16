---
'@postline/adapters-cli': patch
---

fix(cc-worker): pin codex reasoning effort to `low` for headless runs

A codex worker spawned `codex exec` with the operator's global
`model_reasoning_effort` (often `high`/`xhigh` for interactive use). On
short dispatched tasks that made codex deep-reason + autonomously read
`~/.claude/skills/**/SKILL.md` before answering — measured ~31s + 23k input
tokens for a one-word reply.

The codex worker now passes `-c model_reasoning_effort=low` (override via
`codexReasoningEffort`). Same one-word reply drops to ~4s, and codex stops
the skill-discovery detour. Not a postline bug — codex's behaviour under
high reasoning — but the headless worker shouldn't inherit interactive
tuning.

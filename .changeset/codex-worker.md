---
'@postline/adapters-cli': minor
---

feat(cc-worker): codex agent kind — `cc-worker start --agent codex` (PR-AGENT-1)

A worker can now back its dispatched tasks with **Codex** instead of Claude
Code. `runTask` was refactored around an `AgentSpec` (bin + spawn args +
per-line event parser); the shared scaffold (spawn, debounce, deadline,
result assembly, POST) is identical across agents.

- `--agent codex` (or `CC_WORKER_AGENT_KIND=codex`) spawns `codex exec
  --json` (sandbox `workspace-write`) instead of `claude -p`.
- Codex JSONL events map to the same progress protocol: `command_execution`
  → 🔧 tool, `agent_message` → text; final answer = the last
  `agent_message` (codex has no single result field). No bridge change —
  the `ProgressBody` shape is unchanged.
- Worker reports `agentKind: codex` on registration (already plumbed for
  responder attribution + the watch view).

Selector routing (`!pl@codex@repo` reaching a codex worker on a repo that
also has a cc worker) is the follow-on PR-AGENT-2. A codex worker is useful
now for any repo where it's the only registered worker.

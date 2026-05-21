---
'@postline/skill-loader': patch
'@postline/adapters-cli': patch
'@postline/adapters-feishu': patch
'@postline/config': patch
'@postline/core': patch
'@postline/mcp-client': patch
'@postline/providers': patch
'@postline/tools-builtin': patch
---

**Skill script sandbox** — skills bundling a `scripts/` subdirectory (e.g. `pdf`, `docx`, `aws-html-slides`) can now be executed directly via a single global `skill_run` tool instead of forcing the model to chain through `bash`. Risk = `write`, so every call still goes through `/approve`.

The tool is registered automatically iff at least one discovered skill ships `scripts/`. Calls accept `{skill, script, args?, timeout_ms?}` and run under the following constraints:

- `skill` must be a known id (per the discovery snapshot — `include`/`exclude` filters remain authoritative).
- `script` must `realpath` inside the skill's `scripts/` subtree. `..` traversal and symlinks pointing outside are rejected.
- The target must be a regular file with at least one execute bit set.
- The subprocess is `spawn`ed directly (no `bash -c`); the shebang picks the interpreter, argv is forwarded verbatim with no shell expansion or globbing.
- Env is scrubbed to `PATH`, `HOME`, `LANG`, `LC_ALL`, `USER`, `TMPDIR`. Anything else (notably `AWS_*`, `ANTHROPIC_*`, `FEISHU_*`) is dropped so a misbehaving script can't exfiltrate secrets.
- Default timeout 60s, max 300s. stdout+stderr are returned to the model, truncated to 64KB. `SIGTERM` → `SIGKILL` on timeout or `ctx.signal` abort.

`Skill.hasScripts` and `Skill.scriptsDir` are populated at discovery time; the system-prompt fragment for a skill that ships scripts now includes a `skill_run` hint so the model knows the option exists.

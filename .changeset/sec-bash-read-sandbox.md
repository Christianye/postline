---
'@postline/tools-builtin': patch
---

fix(security): close bash_read sandbox bypasses (auto-approved tool)

`bash_read` is auto-approved (no human in the loop), so anything it accepts
runs unprompted. The audit found it accepted several state-mutating / code-
executing forms:

- **Command/process substitution ignored.** `echo $(rm -rf x)` classified as
  a read-only `echo`, but the shell still runs the inner command. Now hard-
  denied (`$(…)`, backticks, `<(…)`/`>(…)`) with a quote-aware scan, so a
  literal `$(` inside single quotes is still allowed.
- **`tee` / `bash` / `sh` were in the read-only allowlist.** `tee` writes
  files; `bash -c '…'` / `sh -c '…'` dispatch arbitrary commands. Removed —
  they have no read-only use; use the (approval-gated) `bash` tool instead.
- **Dangerous flags on otherwise-read-only commands.** `find -delete` /
  `-exec*`, `sed -i` (+ `w`/`e`/`s///w` script writes), `awk` `system()` /
  `print > file` / `-i inplace` are now rejected while the plain read-only
  forms (`sed -n`, `awk '{print …}'`, `find -name`) still pass.
- **Full `process.env` exposure.** bash_read spawned with the entire parent
  environment, so `env` / `printenv` could echo ANTHROPIC / AWS / HMAC /
  Feishu secrets straight back into tool output. It now runs with a scrubbed
  env (PATH/HOME/LANG/TERM/TZ/TMPDIR/USER only). The write-tier `bash` tool
  (approval-gated) is unchanged.

+18 classifier tests (attack cases + read-only-still-allowed regressions).

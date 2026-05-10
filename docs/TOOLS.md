# Tools reference

postline ships 9 built-in tool ids. Each maps to a factory in `@postline/tools-builtin`. Add the id to `tools.builtin` in your config to enable it; configure via `tools.options.<id>`.

## Risk tiers

- `read` → auto-approved, any user can trigger
- `write` → requires allowlist membership; no per-call prompt
- `dangerous` → requires `/approve <id>` reply within 5 minutes; allowlist still required

---

## echo

| | |
|---|---|
| Risk | read |
| Purpose | Smoke test the turn loop / tool-calling flow |
| Config | none |

Returns its input unchanged. Keep it enabled during development to sanity-check the bot without invoking anything real.

---

## web_fetch

| | |
|---|---|
| Risk | read |
| Purpose | GET a public URL |

Config:

```ts
web_fetch: {
  maxBytes?: number,     // default 2 * 1024 * 1024
  timeoutMs?: number,    // default 20_000
  hostDeny?: string[],   // extra hostnames to block in addition to built-in list
}
```

Built-in host block-list:

- `localhost`, `127.0.0.1`, `0.0.0.0`, `::1`
- RFC1918: `10.*`, `192.168.*`, `172.16–31.*`
- Carrier-grade NAT: `100.64–127.*`
- IPv6 link-local / ULA: `fe80:`, `fc00:`, `fd00:`
- Cloud metadata: `169.254.169.254`
- Any hostname ending in `.internal` / `.local` / `.localhost`

The tool will not follow redirects into any of the above. It's a coarse SSRF guard; do not rely on it in hostile network environments.

---

## fs

Expands into three tools: **`fs_read`** (read), **`fs_write`** (write), **`fs_edit`** (write).

Config:

```ts
fs: {
  readAllow?: string[],    // default: ['/tmp']
  writeAllow?: string[],   // default: []  (must be subset of readAllow)
  maxReadBytes?: number,   // default: 256 * 1024
}
```

- Path must match one of the allowed roots (checked via absolute path and `..` normalisation — no traversal).
- `fs_write` overwrites. `fs_edit` replaces the **first** occurrence of `old_string` with `new_string`; fails if `old_string` is not unique (forces the model to provide enough context).
- Binary files returned as escaped text — fine for small files, hostile for large ones.

---

## memory

Expands into **`memory_list`** (read), **`memory_read`** (read), **`memory_write`** (write).

Config:

```ts
memory: {
  gitPush?: boolean,    // default true
  gitTimeoutMs?: number // default 60_000
}
```

`dir` comes from the top-level `memory.dir` config, not from `tools.options.memory`.

`memory_write(name, content, commit_message?)` writes a single file, then (if `gitPush`) `git add <name> && git commit -m <msg> && git push origin HEAD`. Returns the commit SHA.

Safe names: `[a-zA-Z0-9._-]+\.md` only. Path traversal is rejected.

---

## github

Expands into **`gh_query`** (read) and **`gh_action`** (write).

Config:

```ts
github: {
  timeoutMs?: number,        // default 60_000
  maxOutputBytes?: number,   // default 64 * 1024
}
```

Requires the `gh` CLI installed and authenticated (`gh auth status` must pass). Auth is handled outside postline — we never see your tokens.

`gh_query` enforces a read-only subcommand list via regex:
- `repo view/list`, `issue view/list`, `pr view/list/status/checks/diff`
- `run view/list`, `workflow view/list`
- `release view/list`
- `search *`, `api GET <path>`

Everything else goes through `gh_action` (write tier). `gh api` with `-X POST/PATCH/DELETE` is write.

---

## lark_docs

Expands into **`lark_doc_read`**, **`lark_doc_list`**, **`lark_doc_search`** — all `read` tier.

Config:

```ts
lark_docs: {
  maxBytes?: number,    // default 256 * 1024 for extracted text
  timeoutMs?: number,   // default 30_000
}
```

Requires the `feishu` block in config (reuses `appId` + `appSecret` for tenant-token-based access).

URL types handled by `lark_doc_read`:

| URL pattern | handler |
|---|---|
| `/docx/xxx` | `docx.v1.document.rawContent` — plain text |
| `/doc/xxx` | legacy `doc/v2/:tok/raw_content` |
| `/wiki/xxx` | `wiki.v2.space.getNode` → resolve to docx/doc/sheet/bitable → recurse |
| `/sheets/xxx` | enumerate tabs via `sheets/v3/spreadsheetSheet.query`, read values via `sheets/v2/spreadsheets/:tok/values/:range` |
| `/base/xxx` | `bitable.v1.appTable.list` + per-table `appTableRecord.list` (top 50) → JSON |
| `/file/xxx` | `drive.v1.file.download` — if title ends in `.docx` or bytes look like a ZIP, runs through `mammoth.extractRawText` |
| `/slides/xxx` | Not supported yet — returns a clear error suggesting manual PDF export |
| `/drive/folder/xxx` | Use `lark_doc_list` instead — returns not-supported for `_read` |

`lark_doc_list(url)` lists immediate children of a drive folder via `drive.v1.file.list`.

`lark_doc_search(query, type?)` hits `/suite/docs-api/search/object` for tenant-wide doc search. Returns top 20.

Required Feishu scopes:

- `docx:document:readonly`, `drive:drive:readonly`, `wiki:wiki:readonly`
- `sheets:spreadsheet:readonly`, `bitable:app:readonly`, `docs:doc:readonly`

---

## bash_read

| | |
|---|---|
| Risk | read (auto-approved) |
| Purpose | run a shell command whose tokens are all in a read-only allowlist |

Config:

```ts
bash_read: {
  timeoutMs?: number,        // default 60_000
  maxOutputBytes?: number,   // default 64 * 1024
}
```

Allowed:

- 50+ inspection commands: `ls`, `cat`, `head`, `tail`, `wc`, `grep`, `rg`, `find`, `pwd`, `whoami`, `hostname`, `uname`, `date`, `df`, `free`, `ps`, `env`, `which`, `stat`, `echo`, `readlink`, `sort`, `uniq`, `cut`, `awk`, `sed`, `diff`, `jq`, `yq`, … (full list in `bash.ts` `READ_ONLY_COMMANDS`)
- `git log/status/diff/show/rev-parse/branch/remote/ls-files/blame/describe/tag/config/reflog/stash/shortlog/rev-list/cat-file/whatchanged`
- `systemctl status/is-active/is-enabled/is-failed/list-units/show/cat`
- `docker` / `podman` with `ps/images/inspect/logs/top/stats/version/info`
- `journalctl` with any flags
- Multi-modal dev tools (`node/npm/pnpm/yarn/python3/pip/claude/openclaw/go/cargo/rustc/deno/bun/tsc/make/aws/gh`) with:
  - query flags only: `--version`, `-V`, `-v`, `--help`, `-h`, `-?`
  - known read sub-commands: `npm list/view/info`, `pnpm list/outdated`, `pip show/freeze`, `go version/env`, etc.
- Pipes, `&&`, `||`, `;`, redirects to `/dev/null`/`/dev/stderr`/`&N`

Rejected:

- `sudo`, `curl`, `wget`, `fetch` (use `web_fetch`)
- Any token matching write verbs: `install, add, remove, create, update, upgrade, publish, push, deploy, release, start, stop, restart, run, exec, build, commit, merge, rebase, set, unset, sync, clone, pull`
- Output redirection to a file path
- `eval`, `>` to fs paths, `>>` to anything but `/dev/null`
- Bare `node` / `python` (could open REPL = process spawn)
- Any command name not in any allowlist

If bash_read rejects your command, the error string tells you exactly why — if it looks like a false positive, file an issue (see `feedback_tool_anomaly_reporting.md` principle: tool wrongness is the operator's bug, not user's).

---

## bash

| | |
|---|---|
| Risk | dangerous |
| Purpose | execute any shell command |

Config:

```ts
bash: {
  risk?: 'write' | 'dangerous',  // default 'dangerous'
  timeoutMs?: number,            // default 60_000
  maxOutputBytes?: number,       // default 64 * 1024
  denyPatterns?: RegExp[],       // pre-spawn regex reject
}
```

Built-in denyPatterns:

- `rm -rf /` at any path not starting with `/tmp` or `/var/tmp`
- Fork bomb patterns (`:(){ :|:& };:`)
- Redirects to raw disk devices (`> /dev/sda`)

Beyond deny-pattern, every invocation requires `/approve <action_id>` in the originating chat within 5 minutes.

---

## openclaw_bridge

Expands into **`openclaw_say`**, **`openclaw_health`**, **`openclaw_cron_list`** — all `read`.

Config:

```ts
openclaw_bridge: {
  token: string,              // required — gateway auth token
  url?: string,               // default 'ws://localhost:18789'
  defaultSessionId?: string,  // default 'cc-collab'
  bin?: string,               // override openclaw CLI path if systemd PATH lacks it
}
```

These tools shell out to the `openclaw gateway call` CLI to talk to a co-located [openclaw](https://github.com/openclaw/openclaw) agent. Useful only if you run an openclaw instance alongside postline and want your postline bot to be able to delegate to it.

Not relevant for most users — openclaw is a separate third-party project. Leave this tool out of `tools.builtin` if you don't use it.

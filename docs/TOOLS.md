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

Expands into **`memory_list`** (read), **`memory_read`** (read), **`memory_search`** (read), **`memory_write`** (write).

Config:

```ts
memory: {
  gitPush?: boolean,    // default true
  gitTimeoutMs?: number // default 60_000
}
```

`dir` comes from the top-level `memory.dir` config, not from `tools.options.memory`.

`memory_search(query, regex?, case_sensitive?, max_hits?)` grep-s every `*.md` file in the memory dir and returns `file: line: matching-line` entries, capped at `max_hits` (default 40). Scales to a few hundred files — memory is Git, not a vector database. Literal mode is the default; set `regex: true` to use the query as a JS `RegExp`. Case-insensitive by default.

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

## feishu_send

| | |
|---|---|
| Risk | write |
| Purpose | Send a text message to a feishu chat or user (proactive notifications: daily reports, alerts, follow-ups) |

Config (required):

```ts
tools: {
  builtin: ['feishu_send'],
  options: {
    feishu_send: {
      sendAllowlist: ['oc_group_a', 'ou_user_b'],  // hard allowlist; empty = all sends refused
      ratePerMin?: number,                         // default 5 msgs/min/target
      maxChars?: number,                           // default 4500
    },
  },
}
```

`sendAllowlist` is a **hard** allowlist — the tool refuses any target not explicitly listed. Keeps a prompt-injected bot from spamming arbitrary groups the bot has joined.

Input schema:

- `chat_id` (required): `oc_...` for a group, `ou_...` for a user DM. Must be on `sendAllowlist`.
- `text` (required): message body, ≤ `maxChars` chars. No auto-splitting — if the model tries to send more, the tool returns an error asking it to summarise.
- `mentions` (optional): list of open_ids to `@`-mention. Rendered as `<at user_id="ou_xxx"></at>` prefixes.

Rate limiting is per-target, in-memory, 60-second sliding window. Exceeding it returns an `isError` ToolResult instead of throwing, so the model can decide whether to retry later.

Required Feishu scopes:

- `im:message:send_as_bot`
- `im:message` (already required for the channel)

Does **not** need to be the current reply target — use this when you want postline to push to a different chat than the one it was triggered from (e.g. daily report into a status group).

Requires `feishu.appId` + `feishu.appSecret` in config (same credentials the channel adapter uses).

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
- Multi-modal dev tools (`node/npm/pnpm/yarn/python3/pip/claude/go/cargo/rustc/deno/bun/tsc/make/aws/gh`) with:
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

If bash_read rejects your command, the error string tells you exactly why. If the rejection looks like a false positive, please file an issue — we'd rather fix the classifier than have users work around it.

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

## MCP (Model Context Protocol) client

Not a single tool — a bridge. Spawn any number of [Model Context Protocol](https://modelcontextprotocol.io) stdio servers at startup and expose each server's tools to Claude as `mcp_<server>_<tool>`.

| | |
|---|---|
| Risk | `dangerous` by default (per-server overrideable) |
| Purpose | reuse the MCP ecosystem (official servers: filesystem, git, postgres, slack, …) inside postline |
| Config key | `tools.mcp` in `postline.config.ts` |

Config:

```ts
mcp: {
  // Where to source server definitions:
  source?: 'postline' | 'claude-code' | 'both'  // default 'both'

  // Inline server definitions — win on name conflict with claude-code.
  // Three transport shapes:
  servers?: Record<name,
    // stdio (local subprocess)
    | {
        type?: 'stdio'
        command: string
        args?: string[]
        env?: Record<string, string | undefined>
        cwd?: string
      }
    // Streamable HTTP (remote, modern)
    | {
        type: 'http' | 'streamable-http'
        url: string
        headers?: Record<string, string>  // e.g. { Authorization: 'Bearer ...' }
      }
    // Legacy SSE (remote)
    | {
        type: 'sse'
        url: string
        headers?: Record<string, string>
      }
  >

  // Default risk tier for every MCP-sourced tool. Postline defaults to
  // 'dangerous' so every call flows through the /approve gate. If you trust
  // a server is read-only, drop the default to 'read' or override per-tool.
  riskDefault?: 'read' | 'write' | 'dangerous'  // default 'dangerous'

  // Per-tool override, keyed by the postline-visible name (mcp_<server>_<tool>)
  riskOverrides?: Record<postlineToolName, 'read' | 'write' | 'dangerous'>

  claudeConfigPath?: string      // default `${HOME}/.claude.json`
  connectTimeoutMs?: number      // default 10_000
  callTimeoutMs?: number         // default 60_000
  strict?: boolean               // default false — skip failing servers
}
```

### How it works

1. postline resolves servers from `tools.mcp.servers` (inline) and `~/.claude.json → mcpServers` (per `source`).
2. At startup, each server is spawned via `StdioClientTransport`, handshakes via `initialize`, then `tools/list` is called.
3. Every discovered tool is wrapped as a postline `Tool` with name `mcp_<server>_<tool>` and the risk tier you configured. It appears alongside your built-in tools to the turn runner.
4. On shutdown (`SIGINT` / `SIGTERM`), every MCP subprocess is closed.

### Failure modes

- **Command not on PATH** — postline logs `mcp_server_failed`, other servers keep going. `postline doctor` flags it as `mcp: … — missing: <server>`.
- **`initialize` / `tools/list` times out** — same, fail-open. Set `strict: true` if you'd rather crash early.
- **Tool name collision with a built-in** — the built-in wins and the MCP tool is skipped (logged as `mcp_tool_name_collision_skipped`). Rename in your MCP server to resolve.
- **Schema without `type: 'object'`** — patched transparently. Required by Claude tool-use.

### Claude Code compatibility

postline reads `~/.claude.json → mcpServers`, the same format Claude Code / Claude Desktop write. If you already have MCP servers configured for Claude Code, they work in postline unchanged. Use `source: 'postline'` if you want to opt out of that reuse (inline-only).

### Transports supported

| Type | Status | Auth |
|---|---|---|
| `stdio` | ✅ stable | subprocess env + args |
| `http` / `streamable-http` | ✅ 0.1.2+ | request headers (OAuth deferred) |
| `sse` | ✅ 0.1.2+ (legacy) | request headers |
| WebSocket | ❌ | not planned |

### Not supported

- **OAuth flows** over HTTP/SSE — pass a pre-obtained `Authorization: Bearer ...` header yourself. Full OAuth on the roadmap.
- **MCP `resources`, `prompts`** — tools only.
- **Server-initiated `sampling`** — the client never calls the model on the server's behalf.
- **Per-server reconnect** — a dead server stays dead until postline restarts.
- **Runtime add/remove** — config is read once at boot.

---

## Claude Code skills

Not a single tool — a loader. Reads the Claude Code / Claude Desktop skill directory (`~/.claude/skills/<name>/SKILL.md` by default) and exposes each skill as a `skill_<id>` tool. The skill's markdown body is returned verbatim; the model follows it step by step, often calling other tools (`bash_read`, `fs_read`, etc.) along the way.

| | |
|---|---|
| Risk | `read` — the skill tool returns text only. Downstream tools the model then calls are gated by their own risk tier. |
| Purpose | reuse skills you wrote once for Claude Code — same `SKILL.md` format, no duplication |
| Config key | `tools.skills` in `postline.config.ts` |

Config:

```ts
skills: { enabled: false }  // disabled (default — omit the key instead)

// or:
skills: {
  enabled: true,
  dir?: string                // default `${HOME}/.claude/skills`
  strict?: boolean            // default false — skip malformed SKILL.md files
  include?: readonly string[] // opt-in subset
  exclude?: readonly string[] // blocklist
}
```

### How it works

1. On startup, postline walks `dir` and reads every `SKILL.md`.
2. Frontmatter is parsed for `name` / `description` / `disable-model-invocation`.
3. For each skill, postline registers a tool named `skill_<id>` with risk `read`. When called, the tool returns the skill header + body for the model to follow.
4. The system prompt is augmented with an **Available skills** section listing every *non-hidden* skill (those without `disable-model-invocation: true`). The model picks a skill based on description match, calls the tool, and executes the guide.

### Skill frontmatter

postline uses a strict subset of the fields Claude Code honours:

```yaml
---
name: commit-smart
description: One-line hook shown to the model — it decides to call the skill based on this.
disable-model-invocation: true  # optional; default false
---
```

Skills without a `description` are skipped with a warning (or throw if `strict: true`).

### `disable-model-invocation` semantics

- `false` (default) — skill is advertised in the system prompt, model may invoke.
- `true` — skill is NOT advertised. The `skill_<id>` tool is still registered, so an operator / another tool can invoke it explicitly, but the model won't know about it.

### Tool name collisions

If a skill id collides with an existing builtin / MCP tool name, the existing tool wins and the skill is skipped with a `skill_tool_name_collision_skipped` warning. Rename the skill directory to resolve.

### Not supported in MVP

- **No script execution.** `scripts/` or `preview/` subdirectories are ignored — if `SKILL.md` mentions `python scripts/extract.py`, the model has to ask for `bash_read` / `bash` itself.
- **No nested frontmatter.** We parse top-level `key: value` pairs only, no lists, no YAML anchors.
- **No hot-reload.** Skills are loaded at startup; add a new one → restart postline.

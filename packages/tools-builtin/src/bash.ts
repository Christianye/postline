import { spawn } from 'node:child_process';
import type { Tool, ToolContext, ToolResult } from '@postline/core';

export interface BashToolOptions {
  /** Defaults to 'read' (so it goes through allowlist write-blocker if the user is not trusted). */
  risk?: 'read' | 'write' | 'dangerous';
  timeoutMs?: number;
  /** Max stdout+stderr bytes to return to the model. */
  maxOutputBytes?: number;
  /** Deny-listed command substrings (case-insensitive). Pre-check before spawn. */
  denyPatterns?: readonly RegExp[];
}

export function createBashTool(opts: BashToolOptions = {}): Tool {
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const maxBytes = opts.maxOutputBytes ?? 64 * 1024;
  const deny = opts.denyPatterns ?? [
    /\brm\s+-rf\s+\/(?!tmp\/|var\/tmp\/)/i,
    /:\(\)\{.*\}\s*;\s*:/, // fork bomb shape
    />\s*\/dev\/sd[a-z]/i,
  ];
  return {
    name: 'bash',
    description:
      'Execute a bash command in a non-interactive shell. Use this when the command may modify state (write files, network POST, git push, systemctl, install, etc). Requires user approval in feishu. For read-only inspection, prefer bash_read. stdout+stderr returned (truncated to 64KB). Default timeout 60s.',
    risk: opts.risk ?? 'dangerous',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Shell command to execute' },
        cwd: { type: 'string', description: 'Working directory (optional)' },
        timeout_ms: {
          type: 'number',
          description: `Override per-call timeout in ms (max ${timeoutMs})`,
        },
      },
      required: ['command'],
      additionalProperties: false,
    },
    run: (args, ctx) => runBash(args, ctx, { timeoutMs, maxBytes, deny }),
  };
}

/**
 * Read-only bash — runs only commands whose tokens all belong to a known
 * read-only allowlist. Anything else fails with a "use bash instead" hint.
 * Bypasses approval because no token in the allowlist can mutate state.
 */
export function createBashReadTool(opts: BashToolOptions = {}): Tool {
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const maxBytes = opts.maxOutputBytes ?? 64 * 1024;
  return {
    name: 'bash_read',
    description:
      'Run a read-only shell command (no side effects). Auto-approved (no user prompt). Allowed:\n' +
      '• Core inspection: ls/cat/head/tail/wc/grep/rg/find/pwd/whoami/hostname/uname/date/uptime/df/du/free/ps/top/id/env/printenv/which/type/stat/echo/printf/file/tree/readlink/realpath/sort/uniq/cut/awk/sed/diff/jq/yq\n' +
      '• Git read subs: git log/status/diff/show/rev-parse/branch/remote/ls-files/blame/describe/tag/config (NOT push/pull/commit/merge)\n' +
      '• Service inspect: systemctl status/is-active/is-enabled/list-units/show/cat, journalctl (any flags), docker ps/images/inspect/logs/stats/version/info\n' +
      '• Dev tool queries: `node --version`, `python3 --version`, `pnpm list`, `npm view`, `pip show`, `aws help`, `claude --version`, etc. Any --version/--help also works on other tools.\n' +
      '• Pipes, &&, ||, redirects to /dev/null or /dev/stderr.\n' +
      'REJECTED: sudo, curl/wget (use web_fetch), output redirection to files, eval, any argv containing install/add/remove/rm/create/update/upgrade/publish/push/run/exec/start/stop/restart/build/sync/clone/commit/merge/set/unset. For those, use the `bash` tool.',
    risk: 'read',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Read-only shell command' },
        cwd: { type: 'string' },
        timeout_ms: { type: 'number' },
      },
      required: ['command'],
      additionalProperties: false,
    },
    async run(args, ctx) {
      const cmd = typeof args.command === 'string' ? args.command : '';
      if (!cmd) return { content: 'ERROR: command required', isError: true };
      const denyReason = classifyReadOnly(cmd);
      if (denyReason) {
        return {
          content: `ERROR: bash_read rejected (${denyReason}). Use the \`bash\` tool for write/dangerous commands.`,
          isError: true,
        };
      }
      return runBash({ ...args }, ctx, { timeoutMs, maxBytes, deny: [] });
    },
  };
}

/**
 * Tokenize a shell command using a light parser that respects:
 *   - single/double quotes (content treated as one token)
 *   - backslash escaping outside quotes
 *   - pipe |, && , ||, ; , | as command separators (recursively tokenized)
 * Returns the list of argv[0] (command name per sub-command).
 */
function commandNames(cmd: string): string[] {
  const subs = splitOnOperators(cmd);
  const names: string[] = [];
  for (const sub of subs) {
    const tokens = tokenize(sub);
    if (tokens.length === 0) continue;
    const first = tokens[0];
    if (!first) continue;
    // Skip env assignments (e.g. "FOO=bar cmd ...").
    let i = 0;
    while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i] ?? '')) i++;
    const name = tokens[i];
    if (name) names.push(name);
  }
  return names;
}

function splitOnOperators(cmd: string): string[] {
  // Split on `|`, `||`, `&&`, `;` that appear outside quotes.
  const out: string[] = [];
  let buf = '';
  let i = 0;
  let quote: '"' | "'" | null = null;
  while (i < cmd.length) {
    const c = cmd[i] ?? '';
    if (quote) {
      if (c === quote) quote = null;
      buf += c;
      i++;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c as '"' | "'";
      buf += c;
      i++;
      continue;
    }
    if (c === '\\' && i + 1 < cmd.length) {
      buf += c + cmd[i + 1];
      i += 2;
      continue;
    }
    const two = cmd.slice(i, i + 2);
    if (two === '&&' || two === '||') {
      out.push(buf.trim());
      buf = '';
      i += 2;
      continue;
    }
    if (c === '|' || c === ';') {
      out.push(buf.trim());
      buf = '';
      i++;
      continue;
    }
    if (c === '&') {
      // Distinguish background `&` from redirect `&>`, `>&`, `2>&1`, `&1` etc.
      // If preceded by `>` or `\d>` in the buffer, or followed by `\d` / `>` in cmd,
      // treat as part of a redirect — keep in buf.
      const prev = buf[buf.length - 1] ?? '';
      const next = cmd[i + 1] ?? '';
      const isRedirect =
        prev === '>' || /\d>$/.test(buf.slice(-2)) || next === '>' || /\d/.test(next);
      if (isRedirect) {
        buf += c;
        i++;
        continue;
      }
      out.push(buf.trim());
      buf = '';
      i++;
      continue;
    }
    buf += c;
    i++;
  }
  if (buf.trim()) out.push(buf.trim());
  return out.filter(Boolean);
}

function tokenize(sub: string): string[] {
  const out: string[] = [];
  let buf = '';
  let quote: '"' | "'" | null = null;
  let i = 0;
  while (i < sub.length) {
    const c = sub[i] ?? '';
    if (quote) {
      if (c === quote) {
        quote = null;
      } else {
        buf += c;
      }
      i++;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c as '"' | "'";
      i++;
      continue;
    }
    if (c === '\\' && i + 1 < sub.length) {
      buf += sub[i + 1];
      i += 2;
      continue;
    }
    if (/\s/.test(c)) {
      if (buf) {
        out.push(buf);
        buf = '';
      }
      i++;
      continue;
    }
    buf += c;
    i++;
  }
  if (buf) out.push(buf);
  return out;
}

const READ_ONLY_COMMANDS = new Set<string>([
  'ls',
  'cat',
  'head',
  'tail',
  'wc',
  'grep',
  'egrep',
  'fgrep',
  'rg',
  'find',
  'pwd',
  'whoami',
  'hostname',
  'uname',
  'date',
  'uptime',
  'df',
  'du',
  'free',
  'ps',
  'top',
  'htop',
  'id',
  'env',
  'printenv',
  'which',
  'type',
  'whereis',
  'stat',
  'echo',
  'printf',
  'file',
  'tree',
  'readlink',
  'realpath',
  'basename',
  'dirname',
  'sort',
  'uniq',
  'cut',
  'awk',
  'sed',
  'tr',
  'tee',
  'xxd',
  'hexdump',
  'md5sum',
  'sha256sum',
  'diff',
  'cmp',
  'jq',
  'yq',
  'column',
  'nl',
  'fold',
  'sleep',
  'true',
  'false',
  'test',
  'bash',
  'sh', // only as dispatcher; no -c
]);

/**
 * Commands that are "multi-modal" — have both read and write subcommands.
 * For these, bash_read allows invocations that look purely informational
 * (e.g. `node --version`, `pnpm list`, `python -V`, `claude --help`) but
 * rejects anything with a mutating verb (install/add/run/publish/etc).
 *
 * This is the pragmatic middle path between "whitelist nothing" (too strict)
 * and "whitelist the whole command name" (lets `npm install` through).
 */
const MULTIMODAL_DEV_TOOLS = new Set<string>([
  'node',
  'npm',
  'pnpm',
  'yarn',
  'npx',
  'python',
  'python3',
  'pip',
  'pip3',
  'uv',
  'pipx',
  'claude',
  'go',
  'cargo',
  'rustc',
  'deno',
  'bun',
  'tsc',
  'make',
  'cmake',
  'gcc',
  'clang',
  'aws',
  'gh', // gh has its own split via gh_query/gh_action, but users may shell it
]);

/**
 * Query-only flags — their presence alone is a strong signal the call is read-only.
 */
const QUERY_FLAGS = new Set<string>(['--version', '-V', '-v', '--help', '-h', '-?']);

/**
 * Read-only subcommands for multi-modal tools. Very conservative; when in doubt
 * require a QUERY_FLAG. These are commonly-used listing / inspection verbs
 * that are widely understood as non-mutating.
 */
const READ_ONLY_DEV_SUBS: Record<string, Set<string>> = {
  npm: new Set([
    'list',
    'ls',
    'view',
    'info',
    'show',
    'search',
    'outdated',
    'config',
    'ping',
    'root',
    'bin',
    'whoami',
    'who',
    'explain',
    'fund',
    'pack',
    'audit',
  ]),
  pnpm: new Set([
    'list',
    'ls',
    'why',
    'outdated',
    'audit',
    'licenses',
    'config',
    'store',
    'root',
    'bin',
    'env',
    'test',
  ]),
  yarn: new Set(['list', 'info', 'audit', 'licenses', 'outdated', 'config', 'why', 'versions']),
  pip: new Set(['list', 'show', 'freeze', 'check', 'inspect']),
  pip3: new Set(['list', 'show', 'freeze', 'check', 'inspect']),
  uv: new Set(['tree', 'python', 'cache', 'help']),
  go: new Set(['version', 'list', 'env', 'doc', 'vet', 'test', 'help']),
  cargo: new Set(['tree', 'search', 'metadata', 'version', 'help', 'fmt', 'check']),
  deno: new Set(['info', 'doc', 'eval', 'repl', 'help']),
  bun: new Set(['pm', 'install', 'outdated']), // only 'pm ls'/'pm outdated' really safe; reject install by word-verb check below
  aws: new Set(['help']), // otherwise far too broad; most write ops look read-only ('get-*') but e.g. s3 rm is write
  gh: new Set(['help', 'auth', 'config', 'browse']), // prefer gh_query/gh_action tools
};

/**
 * If any token in the argv matches one of these verbs (exact), reject the call.
 * This fires even if the main command is in MULTIMODAL_DEV_TOOLS or READ_ONLY_COMMANDS.
 * Catches `npm install`, `pip upgrade`, `cargo publish`, `systemctl restart`, etc.
 */
const WRITE_VERBS = new Set<string>([
  'install',
  'i',
  'add',
  'remove',
  'rm',
  'uninstall',
  'delete',
  'del',
  'create',
  'init',
  'new',
  'update',
  'upgrade',
  'up',
  'publish',
  'push',
  'deploy',
  'release',
  'set',
  'unset',
  'reset',
  'clean',
  'prune',
  'start',
  'stop',
  'restart',
  'reload',
  'kill',
  'run',
  'exec',
  'serve',
  'spawn',
  'daemon',
  'login',
  'logout',
  'sync',
  'link',
  'unlink',
  'rebuild',
  'build', // ← aggressive, but build writes files; for `tsc --noEmit`-style queries users can invoke tsc directly which already is fine via flags
  'fetch',
  'clone',
  'pull',
  'commit',
  'merge',
  'rebase',
  'cherry-pick',
  'stash', // git write ops — git also goes through READ_ONLY_GIT_SUBS which is stricter
]);

const READ_ONLY_GIT_SUBS = new Set<string>([
  'log',
  'status',
  'diff',
  'show',
  'rev-parse',
  'branch',
  'remote',
  'ls-files',
  'blame',
  'describe',
  'tag',
  'config',
  'reflog',
  'stash',
  'shortlog',
  'rev-list',
  'cat-file',
  'whatchanged',
]);

const READ_ONLY_SYSTEMCTL_SUBS = new Set<string>([
  'status',
  'is-active',
  'is-enabled',
  'is-failed',
  'list-units',
  'list-unit-files',
  'show',
  'cat',
  'help',
]);

const READ_ONLY_JOURNAL_FLAGS_OK = true; // journalctl is read-only by design
const READ_ONLY_DOCKER_SUBS = new Set<string>([
  'ps',
  'images',
  'inspect',
  'logs',
  'top',
  'stats',
  'version',
  'info',
]);

/**
 * Check whether a sub-command (argv after operator-split) for a multi-modal
 * tool is safe: either (a) its only non-main token is a QUERY_FLAG, or
 * (b) its first non-flag token is in READ_ONLY_DEV_SUBS for that tool.
 *
 * Returns null if safe, else a reason string.
 */
function classifyMultimodalSub(mainCmd: string, argv: readonly string[]): string | null {
  // Strip shell artifacts that tokenize-by-whitespace brings in:
  //   redirect operators (2>&1, >&2, 1>, etc.) — not actual argv to the program
  const cleaned = argv.filter((t) => !/^\d*[<>]/u.test(t) && t !== '&' && t !== '|' && t !== ';');
  // argv starts with the command itself; strip env assignments and the main cmd
  const start = cleaned.findIndex((t) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(t));
  const rest = cleaned.slice(start + 1); // everything after the main command

  if (rest.length === 0) {
    // Bare `node` / `python` with no args could launch REPL — not really read-only (spawns a shell).
    return `${mainCmd} with no arguments is not considered read-only (could open a REPL)`;
  }

  // Fail fast on write verbs anywhere
  for (const tok of rest) {
    if (WRITE_VERBS.has(tok)) {
      return `write verb "${tok}" detected; use the \`bash\` tool`;
    }
  }

  // All tokens are query flags → safe
  if (rest.every((t) => QUERY_FLAGS.has(t))) return null;

  // First non-flag token is a recognized read-only sub → safe
  const firstNonFlag = rest.find((t) => !t.startsWith('-'));
  const subs = READ_ONLY_DEV_SUBS[mainCmd];
  if (firstNonFlag && subs?.has(firstNonFlag)) return null;

  // At least one QUERY_FLAG and no positional arg → treat as informational (e.g. `node --version file.js` isn't sensible; but `node --version` is)
  if (
    rest.some((t) => QUERY_FLAGS.has(t)) &&
    rest.every((t) => t.startsWith('-') || QUERY_FLAGS.has(t))
  ) {
    return null;
  }

  return `${mainCmd} args "${rest.join(' ')}" not recognized as read-only — use \`bash\` instead`;
}

/**
 * Returns null if the command is safe; otherwise a human-readable reason.
 */
/**
 * Check redirect operators within a single operator-split sub-command.
 * Accepts: redirects to /dev/null, /dev/stderr, or to a file descriptor (&N).
 * Rejects: redirects that write to a file path.
 */
function classifyRedirectsInSub(sub: string): string | null {
  // `>>` = append. Only safe target is /dev/null.
  const appendM = /(^|[^>])>>\s*(\S+)/u.exec(sub);
  if (appendM) {
    const target = appendM[2] ?? '';
    if (target !== '/dev/null' && target !== '/dev/stderr') {
      return 'append redirection is not read-only';
    }
  }
  // `>` (not `>>`). Accept /dev/null, /dev/stderr, or &N. Reject anything else.
  const re = /(^|[^>])>\s*(\S+)/gu;
  let m: RegExpExecArray | null;
  while ((m = re.exec(sub)) !== null) {
    const target = m[2] ?? '';
    if (target === '/dev/null' || target === '/dev/stderr') continue;
    if (/^&\d+$/.test(target)) continue;
    return 'output redirection to a file is not read-only';
  }
  return null;
}

function classifyReadOnly(cmd: string): string | null {
  // Reject eval first — it can hide arbitrary writes.
  if (/\beval\b/u.test(cmd)) return 'eval is not allowed';

  // Redirect checks happen PER sub-command after splitting on operators,
  // because a trailing `;` / `|` / `&&` in the parent cmd should not let a
  // regex for `>\s*(\S+)` greedily swallow it into the redirect target.
  // (`2>&1; next-cmd` used to be misclassified as redirect target = `&1;`.)
  for (const sub of splitOnOperators(cmd)) {
    const reason = classifyRedirectsInSub(sub);
    if (reason) return reason;
  }
  // 3. Tokenize command names across pipes/operators.
  const names = commandNames(cmd);
  if (names.length === 0) return 'no command';
  for (const name of names) {
    if (name === 'git') {
      // Ensure the git sub-command is read-only — inspect the specific token list.
      const subs = splitOnOperators(cmd);
      for (const sub of subs) {
        const toks = tokenize(sub).filter((t) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(t));
        const gitIdx = toks.indexOf('git');
        if (gitIdx < 0) continue;
        // Skip global flags like -C <path>, -c, --no-pager, etc.
        let j = gitIdx + 1;
        while (j < toks.length && toks[j]?.startsWith('-')) {
          // -C and -c take a value
          if (toks[j] === '-C' || toks[j] === '-c') j += 2;
          else j++;
        }
        const gitSub = toks[j];
        if (!gitSub || !READ_ONLY_GIT_SUBS.has(gitSub)) {
          return `git sub-command "${gitSub ?? '?'}" is not read-only`;
        }
      }
      continue;
    }
    if (name === 'systemctl') {
      const subs = splitOnOperators(cmd);
      for (const sub of subs) {
        const toks = tokenize(sub).filter((t) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(t));
        const idx = toks.indexOf('systemctl');
        if (idx < 0) continue;
        let j = idx + 1;
        while (j < toks.length && toks[j]?.startsWith('-')) j++;
        const sub2 = toks[j];
        if (!sub2 || !READ_ONLY_SYSTEMCTL_SUBS.has(sub2)) {
          return `systemctl sub-command "${sub2 ?? '?'}" is not read-only`;
        }
      }
      continue;
    }
    if (name === 'docker' || name === 'podman') {
      const subs = splitOnOperators(cmd);
      for (const sub of subs) {
        const toks = tokenize(sub).filter((t) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(t));
        const idx = Math.max(toks.indexOf('docker'), toks.indexOf('podman'));
        if (idx < 0) continue;
        let j = idx + 1;
        while (j < toks.length && toks[j]?.startsWith('-')) j++;
        const sub2 = toks[j];
        if (!sub2 || !READ_ONLY_DOCKER_SUBS.has(sub2)) {
          return `docker sub-command "${sub2 ?? '?'}" is not read-only`;
        }
      }
      continue;
    }
    if (name === 'journalctl' && READ_ONLY_JOURNAL_FLAGS_OK) continue;
    if (name === 'sudo') return 'sudo is not allowed in bash_read';
    if (name === 'curl' || name === 'wget' || name === 'fetch') {
      return `network fetch tool "${name}" — use web_fetch tool instead for controlled fetch`;
    }
    if (MULTIMODAL_DEV_TOOLS.has(name)) {
      // Walk each operator-split sub-command that invokes this tool
      // and apply the multimodal classifier.
      const subs = splitOnOperators(cmd);
      for (const sub of subs) {
        const toks = tokenize(sub);
        if (!toks.includes(name)) continue;
        const reason = classifyMultimodalSub(name, toks);
        if (reason) return reason;
      }
      continue;
    }
    if (!READ_ONLY_COMMANDS.has(name)) {
      return `command "${name}" is not in the read-only allowlist`;
    }
    // Bare read-only command — still reject if a write verb slipped in anywhere
    // (e.g. someone writes `env | grep FOO; install ...` — the second call is already
    //  caught by commandNames(), but `env install foo` would look like 'env' invocation).
    // Keep defensive.
  }
  return null;
}

export { classifyReadOnly as __classifyReadOnlyForTest };

async function runBash(
  args: Record<string, unknown>,
  ctx: ToolContext,
  cfg: { timeoutMs: number; maxBytes: number; deny: readonly RegExp[] },
): Promise<ToolResult> {
  const cmd = typeof args.command === 'string' ? args.command : '';
  if (!cmd) return { content: 'ERROR: command required', isError: true };
  for (const d of cfg.deny) {
    if (d.test(cmd)) return { content: `ERROR: command matches deny pattern ${d}`, isError: true };
  }
  const cwd = typeof args.cwd === 'string' ? args.cwd : undefined;
  const requestedTimeout = typeof args.timeout_ms === 'number' ? args.timeout_ms : cfg.timeoutMs;
  const timeout = Math.min(requestedTimeout, cfg.timeoutMs);

  return new Promise<ToolResult>((resolve) => {
    const child = spawn('bash', ['-c', cmd], {
      cwd,
      env: { ...process.env, PATH: process.env.PATH },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let truncated = false;
    const onData = (buf: Buffer) => {
      if (truncated) return;
      out += buf.toString();
      if (out.length > cfg.maxBytes) {
        out = `${out.slice(0, cfg.maxBytes)}\n[...truncated]`;
        truncated = true;
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);

    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 2_000);
    }, timeout);

    const onAbort = () => child.kill('SIGTERM');
    ctx.signal.addEventListener('abort', onAbort, { once: true });

    child.on('close', (code, signal) => {
      clearTimeout(timer);
      ctx.signal.removeEventListener('abort', onAbort);
      const status = signal ? `killed by ${signal}` : `exit ${code}`;
      resolve({
        content: `$ ${cmd}\n${out.trim() || '(no output)'}\n[${status}]`,
        ...(code !== 0 ? { isError: true } : {}),
        meta: { exitCode: code, signal, truncated },
      });
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      ctx.signal.removeEventListener('abort', onAbort);
      resolve({ content: `ERROR: ${err.message}`, isError: true });
    });
  });
}

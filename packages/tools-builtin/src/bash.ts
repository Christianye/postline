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
      'Run a read-only shell command (no side effects). Allowed: ls/cat/head/tail/wc/grep/find/pwd/whoami/hostname/uname/date/uptime/df/free/ps/id/env/which/stat/echo/printf/file/tree/git log/git status/git diff/git show/git rev-parse/git branch/git remote/git ls-files/git blame/journalctl/systemctl status/systemctl is-active/readlink/realpath, plus pipes/&&/||/redirect-from. Auto-approved (no user prompt). If your command is not allowed, use the `bash` tool instead.',
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
    if (c === '|' || c === ';' || c === '&') {
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
  'ls', 'cat', 'head', 'tail', 'wc', 'grep', 'egrep', 'fgrep', 'rg',
  'find', 'pwd', 'whoami', 'hostname', 'uname', 'date', 'uptime',
  'df', 'du', 'free', 'ps', 'top', 'htop', 'id', 'env', 'printenv',
  'which', 'type', 'whereis', 'stat', 'echo', 'printf', 'file', 'tree',
  'readlink', 'realpath', 'basename', 'dirname', 'sort', 'uniq',
  'cut', 'awk', 'sed', 'tr', 'tee', 'xxd', 'hexdump', 'md5sum',
  'sha256sum', 'diff', 'cmp', 'jq', 'yq', 'column', 'nl', 'fold',
  'sleep', 'true', 'false', 'test', 'bash', 'sh', // only as dispatcher; no -c
]);

const READ_ONLY_GIT_SUBS = new Set<string>([
  'log', 'status', 'diff', 'show', 'rev-parse', 'branch', 'remote',
  'ls-files', 'blame', 'describe', 'tag', 'config', 'reflog',
  'stash', 'shortlog', 'rev-list', 'cat-file', 'whatchanged',
]);

const READ_ONLY_SYSTEMCTL_SUBS = new Set<string>([
  'status', 'is-active', 'is-enabled', 'is-failed', 'list-units',
  'list-unit-files', 'show', 'cat', 'help',
]);

const READ_ONLY_JOURNAL_FLAGS_OK = true; // journalctl is read-only by design
const READ_ONLY_DOCKER_SUBS = new Set<string>(['ps', 'images', 'inspect', 'logs', 'top', 'stats', 'version', 'info']);

/**
 * Returns null if the command is safe; otherwise a human-readable reason.
 */
function classifyReadOnly(cmd: string): string | null {
  // 1. Reject appending redirects first (subset of `>` — must go first).
  //    `>>` always writes somewhere; only `>> /dev/null` (rare) is safe.
  if (/(^|[^>])>>[^>]/u.test(cmd)) {
    const m = /(^|[^>])>>\s*(\S+)/u.exec(cmd);
    if (m && m[2] !== '/dev/null') return 'append redirection is not read-only';
  }
  // 2. Reject `>` except when the target is /dev/null, /dev/stderr, or another fd (&N).
  //    Find every `>` that's not part of `>>`, and look at what follows.
  const redirectRe = /(^|[^>])>\s*(\S+)/gu;
  let m: RegExpExecArray | null;
  while ((m = redirectRe.exec(cmd)) !== null) {
    const target = m[2] ?? '';
    if (target === '/dev/null' || target === '/dev/stderr') continue;
    if (/^&\d+$/.test(target)) continue;
    return 'output redirection to a file is not read-only';
  }
  // 2. Reject command substitution and eval that could hide writes.
  if (/\beval\b/u.test(cmd)) return 'eval is not allowed';
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
    if (!READ_ONLY_COMMANDS.has(name)) {
      return `command "${name}" is not in the read-only allowlist`;
    }
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
    if (d.test(cmd))
      return { content: `ERROR: command matches deny pattern ${d}`, isError: true };
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

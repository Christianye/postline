import { spawn } from 'node:child_process';
import type { Tool, ToolResult } from '@postline/core';

export interface GithubToolOptions {
  /** Max bytes returned. Default 64KB. */
  maxOutputBytes?: number;
  /** Timeout per call. Default 60s. */
  timeoutMs?: number;
}

/**
 * Thin wrapper around `gh` CLI. Relies on the host's existing `gh auth status`
 * (no API tokens plumbed through postline). Read/write split:
 *   gh_query   — risk=read. Subcommands: view/list/search/status/api-GET.
 *   gh_action  — risk=write. Everything else (create/edit/close/merge/delete/push).
 */
const READ_PREFIXES: readonly RegExp[] = [
  /^repo\s+view/,
  /^repo\s+list/,
  /^issue\s+view/,
  /^issue\s+list/,
  /^pr\s+view/,
  /^pr\s+list/,
  /^pr\s+status/,
  /^pr\s+checks/,
  /^pr\s+diff/,
  /^run\s+view/,
  /^run\s+list/,
  /^workflow\s+list/,
  /^workflow\s+view/,
  /^release\s+view/,
  /^release\s+list/,
  /^search\s+/,
];

// `gh api` is read-only ONLY for GET. The old `/^api\s+(?!-X)/` allowed
// `gh api --method DELETE …` and `gh api … -f field=x` (the `-f`/`-F`/
// `--field`/`--raw-field`/`--input` flags make gh default to POST), both of
// which mutate. Reject any explicit non-GET method + any field/body flag.
const API_WRITE_FLAG =
  /(?:^|\s)(?:-X|--method)(?:[=\s]+|$)(?!get\b|GET\b)|(?:^|\s)(?:-f|-F|--field|--raw-field|--input)(?:[=\s]|$)/;

function isReadOnlyGh(raw: string): boolean {
  const args = raw.trim();
  if (/^api(\s|$)/.test(args)) {
    // Allow `gh api <path>` and `gh api -X GET …`, reject write methods/fields.
    return !API_WRITE_FLAG.test(args);
  }
  return READ_PREFIXES.some((re) => re.test(args));
}

export { isReadOnlyGh as __isReadOnlyGhForTest };

export function createGithubTools(opts: GithubToolOptions = {}): Tool[] {
  const maxOutputBytes = opts.maxOutputBytes ?? 64 * 1024;
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const isReadOnly = isReadOnlyGh;

  const query: Tool = {
    name: 'gh_query',
    description:
      'Read-only GitHub CLI calls. Allowed subcommands: repo view/list, issue view/list, pr view/list/status/checks/diff, run view/list, workflow view/list, release view/list, search *, api GET. Pass the rest of the command as a string.',
    risk: 'read',
    inputSchema: {
      type: 'object',
      properties: {
        args: {
          type: 'string',
          description: 'The part after `gh `, e.g. "pr view 123 --json title,body"',
        },
      },
      required: ['args'],
      additionalProperties: false,
    },
    async run(input) {
      const argStr = typeof input.args === 'string' ? input.args : '';
      if (!isReadOnly(argStr)) {
        return {
          content:
            'ERROR: gh_query only accepts read-only subcommands (view/list/status/diff/search/api GET)',
          isError: true,
        };
      }
      return runGh(argStr, { maxOutputBytes, timeoutMs });
    },
  };

  const action: Tool = {
    name: 'gh_action',
    description:
      'Write-tier GitHub CLI calls: issue create/edit/close/reopen, pr create/edit/merge/close/comment/review, release create, run rerun, api POST/PATCH/DELETE, etc.',
    risk: 'write',
    inputSchema: {
      type: 'object',
      properties: {
        args: { type: 'string' },
      },
      required: ['args'],
      additionalProperties: false,
    },
    async run(input) {
      const argStr = typeof input.args === 'string' ? input.args : '';
      return runGh(argStr, { maxOutputBytes, timeoutMs });
    },
  };

  return [query, action];
}

function runGh(
  argStr: string,
  cfg: { maxOutputBytes: number; timeoutMs: number },
): Promise<ToolResult> {
  // Naive split — enough for most usage. Complex args with spaces should be
  // wrapped in quotes; for now we require them to JSON.stringify on the model side
  // or users to prefer JSON outputs.
  const args = splitArgs(argStr);
  return new Promise<ToolResult>((resolve) => {
    const child = spawn('gh', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let truncated = false;
    const onData = (b: Buffer) => {
      if (truncated) return;
      out += b.toString();
      if (out.length > cfg.maxOutputBytes) {
        out = `${out.slice(0, cfg.maxOutputBytes)}\n[...truncated]`;
        truncated = true;
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    const timer = setTimeout(() => child.kill('SIGTERM'), cfg.timeoutMs);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({
        content: `$ gh ${argStr}\n${out.trim() || '(no output)'}\n[exit ${code}]`,
        ...(code !== 0 ? { isError: true } : {}),
        meta: { exitCode: code, truncated },
      });
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ content: `ERROR: ${err.message}`, isError: true });
    });
  });
}

/** Minimal arg-splitter that respects single & double quotes. */
function splitArgs(s: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (quote) {
      if (c === quote) quote = null;
      else cur += c;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c as '"' | "'";
      continue;
    }
    if (/\s/.test(c)) {
      if (cur) {
        out.push(cur);
        cur = '';
      }
    } else {
      cur += c;
    }
  }
  if (cur) out.push(cur);
  return out;
}

export { splitArgs as __splitArgsForTest };

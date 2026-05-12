import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type { Tool } from '@postline/core';

export interface MemoryToolsOptions {
  dir: string;
  /**
   * If true, after every write we stage/commit/push. Default true.
   * Turn off for offline/dev use.
   */
  gitPush?: boolean;
  /** Abort long git commands. Default 60s. */
  gitTimeoutMs?: number;
}

/**
 * Three memory tools that operate on a git-backed directory.
 * The directory is expected to already be a git clone (adapter deploy is responsible).
 */
export function createMemoryTools(opts: MemoryToolsOptions): Tool[] {
  const { dir } = opts;
  const gitPush = opts.gitPush ?? true;
  const gitTimeoutMs = opts.gitTimeoutMs ?? 60_000;

  function safeName(name: string): string | null {
    // Prevent escaping the memory dir via path segments.
    if (!/^[a-zA-Z0-9._-]+\.md$/.test(name)) return null;
    return basename(name);
  }

  const listTool: Tool = {
    name: 'memory_list',
    description: `List memory files in ${dir}.`,
    risk: 'read',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    async run() {
      try {
        if (!existsSync(dir))
          return { content: '(memory dir not initialized)', meta: { count: 0 } };
        const files = (await readdir(dir)).filter((f) => f.endsWith('.md') && !f.startsWith('.'));
        return {
          content: files.length === 0 ? '(empty)' : files.sort().join('\n'),
          meta: { count: files.length },
        };
      } catch (e) {
        return { content: `ERROR: ${(e as Error).message}`, isError: true };
      }
    },
  };

  const readTool: Tool = {
    name: 'memory_read',
    description:
      'Read a memory file by name (must be plain filename like "project_x.md", not a path). Use memory_list to discover names.',
    risk: 'read',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string' } },
      required: ['name'],
      additionalProperties: false,
    },
    async run(args) {
      const name = typeof args.name === 'string' ? safeName(args.name) : null;
      if (!name) return { content: 'ERROR: invalid memory name', isError: true };
      const path = join(dir, name);
      if (!existsSync(path))
        return { content: `ERROR: memory "${name}" does not exist`, isError: true };
      return { content: await readFile(path, 'utf8') };
    },
  };

  const searchTool: Tool = {
    name: 'memory_search',
    description:
      'Search memory files for a literal substring or regex. Returns matching files with one line of context per hit. Case-insensitive by default. Scales to a few hundred files (memory is Git, not a database).',
    risk: 'read',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        regex: { type: 'boolean', description: 'Treat query as a regex. Default false (literal).' },
        case_sensitive: { type: 'boolean', description: 'Default false.' },
        max_hits: {
          type: 'number',
          description: 'Cap on matching lines returned. Default 40.',
        },
      },
      required: ['query'],
      additionalProperties: false,
    },
    async run(args) {
      const query = typeof args.query === 'string' ? args.query : '';
      if (!query) return { content: 'ERROR: query is required', isError: true };
      const caseSensitive = args.case_sensitive === true;
      const useRegex = args.regex === true;
      const maxHits = typeof args.max_hits === 'number' && args.max_hits > 0 ? args.max_hits : 40;

      let pattern: RegExp;
      try {
        pattern = useRegex
          ? new RegExp(query, caseSensitive ? '' : 'i')
          : new RegExp(escapeRegex(query), caseSensitive ? '' : 'i');
      } catch (e) {
        return { content: `ERROR: invalid regex: ${(e as Error).message}`, isError: true };
      }

      if (!existsSync(dir)) return { content: '(memory dir not initialized)', meta: { hits: 0 } };

      const files = (await readdir(dir))
        .filter((f) => f.endsWith('.md') && !f.startsWith('.'))
        .sort();

      const hits: string[] = [];
      let totalHits = 0;
      let truncated = false;

      for (const file of files) {
        if (hits.length >= maxHits) {
          truncated = true;
          break;
        }
        let body: string;
        try {
          body = await readFile(join(dir, file), 'utf8');
        } catch {
          continue;
        }
        const lines = body.split(/\r?\n/);
        const fileMatches: string[] = [];
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i] ?? '';
          if (pattern.test(line)) {
            totalHits += 1;
            if (hits.length + fileMatches.length < maxHits) {
              fileMatches.push(`  ${i + 1}: ${trimLine(line)}`);
            } else {
              truncated = true;
            }
          }
        }
        if (fileMatches.length > 0) {
          hits.push(`${file}`, ...fileMatches);
        }
      }

      if (hits.length === 0) {
        return { content: `no match for "${query}" in ${files.length} file(s)`, meta: { hits: 0 } };
      }
      const header = `${totalHits} hit(s) across ${files.length} file(s)${truncated ? ' (truncated)' : ''}:`;
      return { content: [header, ...hits].join('\n'), meta: { hits: totalHits, truncated } };
    },
  };

  const writeTool: Tool = {
    name: 'memory_write',
    description:
      'Create or overwrite a memory file. Name must be like "project_foo.md". After writing, auto-commits+pushes to the remote unless gitPush is disabled. Returns the git sha on success.',
    risk: 'write',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        content: { type: 'string' },
        commit_message: {
          type: 'string',
          description: 'Optional; defaults to "memory: update <name>"',
        },
      },
      required: ['name', 'content'],
      additionalProperties: false,
    },
    async run(args, ctx) {
      const name = typeof args.name === 'string' ? safeName(args.name) : null;
      const content = typeof args.content === 'string' ? args.content : '';
      if (!name) return { content: 'ERROR: invalid memory name', isError: true };
      const path = join(dir, name);
      try {
        await mkdir(dir, { recursive: true });
        await writeFile(path, content, 'utf8');
      } catch (e) {
        return { content: `ERROR writing: ${(e as Error).message}`, isError: true };
      }
      if (!gitPush) return { content: `memory_write ok (local only): ${name}` };

      const commitMsg =
        typeof args.commit_message === 'string' && args.commit_message
          ? args.commit_message
          : `memory: update ${name}`;
      try {
        await git(dir, ['add', name], gitTimeoutMs);
        const diff = await git(dir, ['diff', '--cached', '--quiet'], gitTimeoutMs, {
          allowNonZero: true,
        });
        if (diff.exitCode === 0) {
          return { content: `memory_write ok: ${name} (no changes vs remote, nothing committed)` };
        }
        await git(dir, ['commit', '-m', commitMsg], gitTimeoutMs);
        const sha = (await git(dir, ['rev-parse', 'HEAD'], gitTimeoutMs)).stdout.trim();
        await git(dir, ['push', 'origin', 'HEAD'], gitTimeoutMs);
        ctx.log.info({ name, sha }, 'memory_write_pushed');
        return {
          content: `memory_write ok: ${name} committed ${sha.slice(0, 7)} and pushed`,
          meta: { sha },
        };
      } catch (e) {
        return {
          content: `memory_write: file written but git failed: ${(e as Error).message}`,
          isError: true,
        };
      }
    },
  };

  return [listTool, readTool, searchTool, writeTool];
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function trimLine(s: string): string {
  const trimmed = s.length > 200 ? `${s.slice(0, 200)}…` : s;
  return trimmed.trimEnd();
}

function git(
  cwd: string,
  args: string[],
  timeoutMs: number,
  opts: { allowNonZero?: boolean } = {},
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d.toString()));
    child.stderr.on('data', (d) => (err += d.toString()));
    const timer = setTimeout(() => child.kill('SIGTERM'), timeoutMs);
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0 && !opts.allowNonZero) {
        reject(new Error(`git ${args.join(' ')} failed (${code}): ${err.trim() || out.trim()}`));
        return;
      }
      resolve({ stdout: out, stderr: err, exitCode: code ?? -1 });
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
  });
}

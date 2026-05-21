import { spawn } from 'node:child_process';
import { realpath, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { Tool, ToolContext, ToolResult } from '@postline/core';
import type { Skill } from './types.js';

/**
 * Bound on per-call timeout. Anything longer almost certainly means the
 * script is wrong (or hung) — better to kill and let the model see the
 * timeout than to hold the turn open for 10+ minutes.
 */
const MAX_TIMEOUT_MS = 300_000;
const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_OUTPUT_BYTES = 64 * 1024;

/**
 * Subset of env vars forwarded to script subprocesses. Anything not on this
 * list (notably API keys, AWS_*, ANTHROPIC_*, FEISHU_*) is dropped so a
 * misbehaving script can't exfiltrate secrets via env. PATH and HOME stay
 * because typical scripts need them; LANG/USER/TMPDIR cover common defaults.
 */
const ALLOWED_ENV_KEYS = ['PATH', 'HOME', 'LANG', 'LC_ALL', 'USER', 'TMPDIR'] as const;

export interface SkillRunOptions {
  /** Per-call default timeout in ms (capped at MAX_TIMEOUT_MS). */
  timeoutMs?: number;
  /** Max stdout+stderr bytes returned to the model. */
  maxOutputBytes?: number;
}

/**
 * Single global tool that executes a script bundled under a skill's
 * `scripts/` directory. Risk = `write` because scripts can produce files,
 * call the network, etc. — every call goes through `/approve`.
 *
 * The `skills` argument is the snapshot of discovered skills at startup;
 * the tool will reject any skill id not in the snapshot, even if a matching
 * directory exists on disk. This keeps include/exclude filters effective
 * and prevents drive-by execution of skills the operator chose to suppress.
 */
export function createSkillRunTool(skills: readonly Skill[], opts: SkillRunOptions = {}): Tool {
  const timeoutDefault = Math.min(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);
  const maxBytes = opts.maxOutputBytes ?? MAX_OUTPUT_BYTES;
  const byId = new Map(skills.filter((s) => s.hasScripts).map((s) => [s.id, s]));

  return {
    name: 'skill_run',
    description: buildDescription(byId),
    risk: 'write',
    inputSchema: {
      type: 'object',
      properties: {
        skill: {
          type: 'string',
          description: 'Skill id (directory name) — must be one of the skills listed above.',
        },
        script: {
          type: 'string',
          description:
            "Path to the script relative to the skill's scripts/ directory. Must resolve inside scripts/ — `..` traversal is rejected.",
        },
        args: {
          type: 'array',
          items: { type: 'string' },
          description: 'Argument vector passed to the script. Each item becomes one argv entry.',
        },
        timeout_ms: {
          type: 'number',
          description: `Override per-call timeout (max ${MAX_TIMEOUT_MS}ms).`,
        },
      },
      required: ['skill', 'script'],
      additionalProperties: false,
    },
    async run(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
      const skillId = typeof args.skill === 'string' ? args.skill : '';
      const scriptArg = typeof args.script === 'string' ? args.script : '';
      const argv = Array.isArray(args.args) ? (args.args as unknown[]).map((a) => String(a)) : [];
      const requested =
        typeof args.timeout_ms === 'number' && Number.isFinite(args.timeout_ms)
          ? args.timeout_ms
          : timeoutDefault;
      const timeout = Math.min(Math.max(requested, 1), MAX_TIMEOUT_MS);

      const skill = byId.get(skillId);
      if (!skill || !skill.scriptsDir) {
        return {
          content: `ERROR: unknown skill '${skillId}' or skill has no scripts/ directory. Known: ${[...byId.keys()].join(', ') || '(none)'}`,
          isError: true,
        };
      }

      // Resolve once for path-traversal containment. We call realpath on both
      // the candidate AND the scripts dir so symlinks-pointing-out also fail.
      const candidate = resolve(skill.scriptsDir, scriptArg);
      let candidateReal: string;
      let scriptsReal: string;
      try {
        scriptsReal = await realpath(skill.scriptsDir);
      } catch (err) {
        return {
          content: `ERROR: cannot resolve scripts dir for skill '${skillId}': ${(err as Error).message}`,
          isError: true,
        };
      }
      try {
        candidateReal = await realpath(candidate);
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === 'ENOENT') {
          return { content: `ERROR: script not found: ${scriptArg}`, isError: true };
        }
        return {
          content: `ERROR: cannot resolve script: ${(err as Error).message}`,
          isError: true,
        };
      }

      if (!isInside(scriptsReal, candidateReal)) {
        return {
          content: `ERROR: script '${scriptArg}' resolves outside the skill's scripts/ directory — refusing`,
          isError: true,
        };
      }

      // Must be a regular file with at least one execute bit set. We rely on
      // the OS to enforce execute permission at exec time, but checking up
      // front gives a clearer error than ENOEXEC / EACCES from spawn.
      let mode: number;
      try {
        const st = await stat(candidateReal);
        if (!st.isFile()) {
          return { content: `ERROR: '${scriptArg}' is not a regular file`, isError: true };
        }
        mode = st.mode;
      } catch (err) {
        return { content: `ERROR: stat failed: ${(err as Error).message}`, isError: true };
      }
      if ((mode & 0o111) === 0) {
        return {
          content: `ERROR: '${scriptArg}' is not executable (chmod +x). Mode: 0${(mode & 0o777).toString(8)}`,
          isError: true,
        };
      }

      ctx.log.debug(
        { skill: skillId, script: scriptArg, argc: argv.length, timeoutMs: timeout },
        'skill_run_invoke',
      );

      return execScript(candidateReal, argv, {
        cwd: skill.scriptsDir,
        timeoutMs: timeout,
        maxBytes,
        signal: ctx.signal,
        skillId,
        scriptDisplay: scriptArg,
      });
    },
  };
}

function execScript(
  bin: string,
  argv: readonly string[],
  cfg: {
    cwd: string;
    timeoutMs: number;
    maxBytes: number;
    signal: AbortSignal;
    skillId: string;
    scriptDisplay: string;
  },
): Promise<ToolResult> {
  return new Promise((resolveResult) => {
    const env = scrubEnv(process.env);
    // spawn(bin, argv, ...) — NOT bash -c. The shebang on the script chooses
    // the interpreter; argv items are passed verbatim, no shell expansion,
    // no quoting hazards.
    const child = spawn(bin, [...argv], {
      cwd: cfg.cwd,
      env,
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
    }, cfg.timeoutMs);

    const onAbort = () => child.kill('SIGTERM');
    cfg.signal.addEventListener('abort', onAbort, { once: true });

    child.on('close', (code, signal) => {
      clearTimeout(timer);
      cfg.signal.removeEventListener('abort', onAbort);
      const status = signal ? `killed by ${signal}` : `exit ${code}`;
      const argDisplay = argv.length > 0 ? ` ${argv.map(quoteArg).join(' ')}` : '';
      resolveResult({
        content: `$ skill_run ${cfg.skillId} ${cfg.scriptDisplay}${argDisplay}\n${out.trim() || '(no output)'}\n[${status}]`,
        ...(code !== 0 ? { isError: true } : {}),
        meta: {
          skill: cfg.skillId,
          script: cfg.scriptDisplay,
          exitCode: code,
          signal,
          truncated,
        },
      });
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      cfg.signal.removeEventListener('abort', onAbort);
      resolveResult({ content: `ERROR: spawn failed: ${err.message}`, isError: true });
    });
  });
}

function scrubEnv(src: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of ALLOWED_ENV_KEYS) {
    const v = src[k];
    if (typeof v === 'string') out[k] = v;
  }
  return out;
}

function isInside(parent: string, child: string): boolean {
  // Normalise trailing separator so e.g. /foo/scripts isn't reported as
  // containing /foo/scripts-extra.
  const p = parent.endsWith('/') ? parent : `${parent}/`;
  return child === parent || child.startsWith(p);
}

function quoteArg(s: string): string {
  if (/^[\w\-./@:=]+$/.test(s)) return s;
  return `'${s.replace(/'/g, "'\\''")}'`;
}

function buildDescription(byId: ReadonlyMap<string, Skill>): string {
  if (byId.size === 0) {
    return "Run a script bundled under a skill's scripts/ directory. (No skills with scripts/ are currently loaded.)";
  }
  const lines = [...byId.values()].map((s) => `- **${s.id}** — ${s.description}`);
  return [
    "Run a script bundled under a skill's scripts/ directory. Risk=write — every call requires user approval. The script must already exist under the skill's scripts/ subtree; ../ traversal and symlinks pointing outside are rejected.",
    '',
    'Skills exposing scripts:',
    lines.join('\n'),
    '',
    'argv is forwarded verbatim — no shell expansion. Env is scrubbed to PATH/HOME/LANG/USER/TMPDIR; secrets in process.env are NOT inherited. Default timeout 60s, max 300s. stdout+stderr returned, truncated to 64KB.',
  ].join('\n');
}

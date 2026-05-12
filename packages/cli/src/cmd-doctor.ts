import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { delimiter, isAbsolute, join, resolve } from 'node:path';
import { loadPostlineConfig, validateConfig } from '@postline/config';

interface Check {
  name: string;
  status: 'ok' | 'warn' | 'fail';
  detail: string;
}

/**
 * `postline doctor`: sanity-check the current host. Reads node/pnpm/git versions,
 * looks for AWS / Anthropic credentials, validates the resolved config, probes
 * the memory directory. Does NOT call any external API. Exit code is non-zero
 * only if a fail-class check found a real blocker.
 */
export async function runDoctor(argv: readonly string[]): Promise<void> {
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(
      [
        'Usage: postline doctor',
        '',
        '  Inspects the local host for Node/pnpm/git versions, credential env',
        '  vars, config resolvability, and memory-dir state. Read-only — never',
        '  talks to an LLM or feishu server.',
        '',
      ].join('\n'),
    );
    return;
  }

  const checks: Check[] = [];

  checks.push(checkNode());
  checks.push(checkBinary('pnpm'));
  checks.push(checkBinary('git'));
  checks.push(checkCredentials());
  checks.push(await checkConfig());
  checks.push(checkMemoryDir());
  checks.push(await checkMcp());
  checks.push(await checkSkills());

  const maxName = Math.max(...checks.map((c) => c.name.length));
  for (const c of checks) {
    const tag = c.status === 'ok' ? '  ok' : c.status === 'warn' ? 'warn' : 'FAIL';
    process.stdout.write(`[${tag}] ${c.name.padEnd(maxName)}  ${c.detail}\n`);
  }

  const fails = checks.filter((c) => c.status === 'fail').length;
  if (fails > 0) {
    process.stderr.write(`\n${fails} check(s) failed. Fix the FAIL lines above.\n`);
    process.exit(1);
  }
}

function checkNode(): Check {
  const major = Number.parseInt(process.versions.node.split('.')[0] ?? '0', 10);
  if (major >= 22) {
    return { name: 'node', status: 'ok', detail: `v${process.versions.node}` };
  }
  return {
    name: 'node',
    status: 'fail',
    detail: `v${process.versions.node} — postline requires Node 22 or newer`,
  };
}

function checkBinary(bin: string): Check {
  const r = spawnSync(bin, ['--version'], { encoding: 'utf8' });
  if (r.status !== 0) {
    return { name: bin, status: 'fail', detail: `not found on PATH` };
  }
  const version = (r.stdout ?? '').trim().split('\n')[0] ?? '?';
  return { name: bin, status: 'ok', detail: version };
}

function checkCredentials(): Check {
  const hasAnthropic = !!process.env.ANTHROPIC_API_KEY;
  const hasAws =
    !!process.env.AWS_ACCESS_KEY_ID ||
    !!process.env.AWS_PROFILE ||
    !!process.env.AWS_WEB_IDENTITY_TOKEN_FILE; // IAM role
  if (hasAnthropic && hasAws) {
    return { name: 'llm-creds', status: 'ok', detail: 'Anthropic + AWS both present' };
  }
  if (hasAnthropic) return { name: 'llm-creds', status: 'ok', detail: 'ANTHROPIC_API_KEY set' };
  if (hasAws) return { name: 'llm-creds', status: 'ok', detail: 'AWS credentials present' };
  return {
    name: 'llm-creds',
    status: 'warn',
    detail: 'no ANTHROPIC_API_KEY / AWS creds detected — set one before running chat/start',
  };
}

async function checkConfig(): Promise<Check> {
  try {
    const cfg = await loadPostlineConfig();
    const errs = validateConfig(cfg);
    if (errs.length > 0) {
      return { name: 'config', status: 'fail', detail: errs.join('; ') };
    }
    const where = process.env.POSTLINE_CONFIG ?? 'postline.config.{ts,mjs,js} via workspace walk';
    return {
      name: 'config',
      status: 'ok',
      detail: `provider=${cfg.provider.name}, model=${cfg.model}, tools=${cfg.tools.builtin.length} (${where})`,
    };
  } catch (e) {
    return { name: 'config', status: 'fail', detail: (e as Error).message };
  }
}

async function checkMcp(): Promise<Check> {
  // Best-effort: peek at cfg.tools.mcp, count servers, and verify each command
  // resolves on PATH. We do NOT spawn the subprocesses — that's what `chat` /
  // `feishu` start-up does, and real failures surface in those logs.
  try {
    const cfg = await loadPostlineConfig();
    const mcp = cfg.tools.mcp;
    if (!mcp) {
      return { name: 'mcp', status: 'ok', detail: 'disabled (cfg.tools.mcp not set)' };
    }
    const { resolveServers } = await import('@postline/mcp-client');
    const servers = await resolveServers({
      ...(mcp.source !== undefined ? { source: mcp.source } : {}),
      ...(mcp.servers !== undefined ? { servers: mcp.servers } : {}),
      ...(mcp.claudeConfigPath !== undefined ? { claudeConfigPath: mcp.claudeConfigPath } : {}),
    });
    const total = Object.keys(servers).length;
    if (total === 0) {
      return {
        name: 'mcp',
        status: 'warn',
        detail: 'configured but 0 servers resolved (check source / paths)',
      };
    }
    // Only stdio transports have a PATH-resolvable command to verify. HTTP /
    // SSE servers are remote — we'd need a network hit to check them, which
    // doctor should never do.
    let stdioCount = 0;
    let stdioResolvable = 0;
    let remoteCount = 0;
    const missing: string[] = [];
    for (const [name, cfg] of Object.entries(servers)) {
      const type = cfg.type ?? 'stdio';
      if (type === 'stdio') {
        stdioCount += 1;
        const stdioCfg = cfg as Extract<typeof cfg, { command: string }>;
        if (isCommandResolvable(stdioCfg.command)) stdioResolvable += 1;
        else missing.push(name);
      } else {
        remoteCount += 1;
      }
    }
    const parts: string[] = [];
    if (stdioCount > 0) {
      parts.push(`${stdioResolvable}/${stdioCount} stdio server(s) on PATH`);
    }
    if (remoteCount > 0) {
      parts.push(`${remoteCount} remote server(s) (http/sse — not network-checked)`);
    }
    if (missing.length > 0) {
      return {
        name: 'mcp',
        status: 'warn',
        detail: `${parts.join(', ')} — missing stdio: ${missing.join(', ')}`,
      };
    }
    return {
      name: 'mcp',
      status: 'ok',
      detail: `${total} server(s) configured (${parts.join(', ')})`,
    };
  } catch (e) {
    return { name: 'mcp', status: 'warn', detail: (e as Error).message };
  }
}

async function checkSkills(): Promise<Check> {
  try {
    const cfg = await loadPostlineConfig();
    const skills = cfg.tools.skills;
    if (!skills || !skills.enabled) {
      return { name: 'skills', status: 'ok', detail: 'disabled (cfg.tools.skills not enabled)' };
    }
    const { discoverSkills } = await import('@postline/skill-loader');
    const { enabled: _enabled, ...opts } = skills;
    const warnings: string[] = [];
    const found = await discoverSkills({
      ...opts,
      onWarn: (m) => warnings.push(m),
    });
    if (found.length === 0) {
      return {
        name: 'skills',
        status: 'warn',
        detail: `enabled but 0 skills loaded (check dir=${opts.dir ?? '~/.claude/skills'})`,
      };
    }
    const hidden = found.filter((s) => s.disableModelInvocation).length;
    const adv = found.length - hidden;
    const warnNote = warnings.length > 0 ? `, ${warnings.length} warning(s)` : '';
    return {
      name: 'skills',
      status: 'ok',
      detail: `${found.length} loaded (${adv} advertised, ${hidden} hidden${warnNote})`,
    };
  } catch (e) {
    return { name: 'skills', status: 'warn', detail: (e as Error).message };
  }
}

/** Cross-platform `which <cmd>`: check every PATH entry for an executable. */
function isCommandResolvable(command: string): boolean {
  if (!command) return false;
  if (isAbsolute(command)) return existsSync(command);
  const path = process.env.PATH ?? '';
  for (const dir of path.split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, command);
    if (existsSync(candidate)) return true;
  }
  return false;
}

function checkMemoryDir(): Check {
  // Only meaningful if a config loads.
  try {
    // Re-resolve synchronously via env — avoid async coupling with loadConfig.
    const envDir = process.env.CC_MEMORY_DIR;
    if (!envDir) {
      return {
        name: 'memory-dir',
        status: 'warn',
        detail: 'skipped — need config resolution for the authoritative dir',
      };
    }
    const resolved = resolve(envDir);
    if (!existsSync(resolved)) {
      return { name: 'memory-dir', status: 'warn', detail: `${resolved} does not exist` };
    }
    const hasGit = existsSync(resolve(resolved, '.git'));
    return {
      name: 'memory-dir',
      status: 'ok',
      detail: `${resolved} ${hasGit ? '(git-backed)' : '(not a git repo)'}`,
    };
  } catch (e) {
    return { name: 'memory-dir', status: 'warn', detail: (e as Error).message };
  }
}

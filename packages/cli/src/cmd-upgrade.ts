import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

interface UpgradeOpts {
  repoDir: string;
  yes: boolean; // skip the "proceed?" prompt when there are incoming commits
}

/**
 * `postline upgrade`: pull the latest main, re-install deps, re-build, and (if
 * a systemd `cc.service` unit is active) restart it. Local uncommitted changes
 * are preserved via `git stash` around the pull. Conflicts abort cleanly.
 *
 * Not for fresh installs — use `curl | bash` (deploy/scripts/install.sh) for
 * first-time setup, then `postline upgrade` from then on.
 */
export async function runUpgrade(argv: readonly string[]): Promise<void> {
  const opts = parseArgs(argv);
  const cwd = opts.repoDir;

  if (!existsSync(resolve(cwd, '.git'))) {
    die(`${cwd} is not a git repo — postline upgrade only works on git-installed checkouts`);
  }
  if (!existsSync(resolve(cwd, 'pnpm-workspace.yaml'))) {
    die(`${cwd} does not look like a postline checkout (no pnpm-workspace.yaml)`);
  }

  info(`repo: ${cwd}`);

  // 1. Fetch + compare.
  run('git', ['fetch', '--quiet', 'origin', 'main'], cwd);
  const localSha = capture('git', ['rev-parse', 'HEAD'], cwd).trim();
  const remoteSha = capture('git', ['rev-parse', 'origin/main'], cwd).trim();
  if (localSha === remoteSha) {
    info(`already up to date at ${localSha.slice(0, 7)}.`);
    return;
  }

  // Check for divergence: if the local branch has commits origin doesn't have,
  // a fast-forward pull would fail. Bail early with a clear message.
  const aheadCount = capture(
    'git',
    ['rev-list', '--count', `${remoteSha}..${localSha}`],
    cwd,
  ).trim();
  if (aheadCount !== '0') {
    info(`local HEAD is ${aheadCount} commit(s) ahead of origin/main — nothing to upgrade to.`);
    info('(you have unpushed work; `git push` it or `git reset --hard origin/main` to discard)');
    return;
  }

  // 2. Show the user what's coming in.
  const log = capture('git', ['log', '--oneline', `${localSha}..${remoteSha}`], cwd);
  info(`incoming commits (${localSha.slice(0, 7)} → ${remoteSha.slice(0, 7)}):`);
  process.stdout.write(`${log}\n`);

  if (!opts.yes) {
    const ok = await confirm('proceed with upgrade? [y/N] ');
    if (!ok) {
      info('aborted.');
      return;
    }
  }

  // 3. Stash local changes if the working tree is dirty.
  const dirty = capture('git', ['status', '--porcelain'], cwd).trim().length > 0;
  let stashed = false;
  if (dirty) {
    info('working tree has local changes — stashing before pull');
    run('git', ['stash', 'push', '--include-untracked', '-m', 'postline-upgrade-autostash'], cwd);
    stashed = true;
  }

  // 4. Fast-forward to origin/main.
  try {
    run('git', ['pull', '--ff-only', 'origin', 'main'], cwd);
  } catch (e) {
    if (stashed) {
      warn('pull failed — restoring stashed changes');
      try {
        run('git', ['stash', 'pop'], cwd);
      } catch {
        warn('stash pop also failed; your changes are in `git stash list`');
      }
    }
    throw e;
  }

  // 5. Restore local patches. Conflict here is a user decision — we bail loudly.
  if (stashed) {
    try {
      run('git', ['stash', 'pop'], cwd);
      info('local changes restored.');
    } catch {
      warn(
        'stash pop produced conflicts. Your patches are preserved in `git stash list`. ' +
          'Resolve manually, then commit or `git stash drop` when done.',
      );
      process.exit(2);
    }
  }

  // 6. Re-install deps + re-build.
  info('re-installing deps (pnpm install --frozen-lockfile)');
  run('pnpm', ['install', '--frozen-lockfile'], cwd);
  info('re-building all packages (pnpm -r build)');
  run('pnpm', ['-r', 'build'], cwd);

  // 7. If a systemd cc.service is active on this host, restart it.
  if (isSystemctlActive('cc.service')) {
    info('cc.service is active — restarting');
    run('sudo', ['systemctl', 'restart', 'cc.service'], cwd);
  } else {
    info('cc.service not active on this host — skipping systemd restart');
  }

  const newSha = capture('git', ['rev-parse', 'HEAD'], cwd);
  info(`upgrade complete — now at ${newSha.slice(0, 7)}.`);
}

function parseArgs(argv: readonly string[]): UpgradeOpts {
  let repoDir = process.env.POSTLINE_REPO_DIR ?? process.cwd();
  let yes = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--yes' || a === '-y') yes = true;
    else if (a === '--repo' || a === '--repo-dir') {
      i += 1;
      const next = argv[i];
      if (!next) die('--repo requires a path argument');
      repoDir = resolve(next);
    } else if (a === '--help' || a === '-h') {
      process.stdout.write(
        [
          'Usage: postline upgrade [--yes] [--repo <path>]',
          '',
          '  --yes, -y         skip the confirmation prompt',
          '  --repo <path>     repo directory (default: cwd or $POSTLINE_REPO_DIR)',
          '',
          'Behaviour: fetch origin/main, show incoming commits, stash local edits,',
          'fast-forward pull, pop the stash, re-install + re-build, and restart',
          'cc.service if it exists on this host.',
          '',
        ].join('\n'),
      );
      process.exit(0);
    } else {
      die(`unknown argument: ${a}`);
    }
  }
  return { repoDir, yes };
}

function formatExit(r: ReturnType<typeof spawnSync>): string {
  return r.status !== null ? `exit ${r.status}` : `signal ${r.signal}`;
}

function run(cmd: string, args: readonly string[], cwd: string): void {
  const r = spawnSync(cmd, args, { cwd, stdio: 'inherit' });
  if (r.status !== 0) {
    throw new Error(`${cmd} ${args.join(' ')} — ${formatExit(r)}`);
  }
}

function capture(cmd: string, args: readonly string[], cwd: string): string {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) {
    throw new Error(`${cmd} ${args.join(' ')} — ${formatExit(r)}: ${r.stderr}`);
  }
  return r.stdout;
}

function isSystemctlActive(unit: string): boolean {
  // `systemctl is-active` returns 0 if active, non-zero otherwise. Absence of
  // systemctl entirely (macOS, containers) also returns non-zero via the catch.
  try {
    const r = spawnSync('systemctl', ['is-active', '--quiet', unit]);
    return r.status === 0;
  } catch {
    return false;
  }
}

async function confirm(prompt: string): Promise<boolean> {
  if (!process.stdin.isTTY) return true; // non-interactive: assume consent (CI, pipelines)
  process.stdout.write(prompt);
  return new Promise<boolean>((resolvePromise) => {
    process.stdin.setEncoding('utf8');
    const onData = (chunk: string): void => {
      process.stdin.off('data', onData);
      process.stdin.pause();
      resolvePromise(/^y(es)?$/i.test(chunk.trim()));
    };
    process.stdin.on('data', onData);
    process.stdin.resume();
  });
}

function info(msg: string): void {
  process.stdout.write(`[upgrade] ${msg}\n`);
}
function warn(msg: string): void {
  process.stderr.write(`[upgrade] WARN: ${msg}\n`);
}
function die(msg: string): never {
  process.stderr.write(`[upgrade] ERROR: ${msg}\n`);
  process.exit(1);
}

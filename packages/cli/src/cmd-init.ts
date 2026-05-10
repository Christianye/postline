import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';

/**
 * `postline init`: scaffold a fresh workspace. Copies postline.config.example.ts
 * to postline.config.ts if missing, and initialises ~/.postline/memory as a git
 * repo with a placeholder MEMORY.md. Idempotent — existing files are never
 * overwritten.
 */
export async function runInit(argv: readonly string[]): Promise<void> {
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(
      [
        'Usage: postline init [--repo <path>] [--memory <path>]',
        '',
        '  Idempotent: safe to re-run. Existing files are never overwritten.',
        '',
      ].join('\n'),
    );
    return;
  }

  const repoDir = argOr(argv, '--repo', process.env.POSTLINE_REPO_DIR ?? process.cwd());
  const memoryDir = argOr(argv, '--memory', resolve(homedir(), '.postline', 'memory'));

  info(`repo dir:   ${repoDir}`);
  info(`memory dir: ${memoryDir}`);

  const cfgDst = resolve(repoDir, 'postline.config.ts');
  const cfgSrc = resolve(repoDir, 'postline.config.example.ts');
  if (existsSync(cfgDst)) {
    info('postline.config.ts already exists — leaving it alone');
  } else if (existsSync(cfgSrc)) {
    copyFileSync(cfgSrc, cfgDst);
    info(`created ${cfgDst} from example`);
  } else {
    warn(
      `postline.config.example.ts not found at ${cfgSrc} — skipping config scaffold (use --repo if you ran this outside a postline checkout)`,
    );
  }

  if (!existsSync(memoryDir)) {
    mkdirSync(memoryDir, { recursive: true });
    info(`created ${memoryDir}`);
  }

  const memoryIndex = resolve(memoryDir, 'MEMORY.md');
  if (!existsSync(memoryIndex)) {
    writeFileSync(
      memoryIndex,
      [
        '# My postline memory',
        '',
        'One-line pointers to the individual memory files in this directory.',
        '',
      ].join('\n'),
    );
    info(`created ${memoryIndex}`);
  }

  if (!existsSync(resolve(memoryDir, '.git'))) {
    const gitInit = spawnSync('git', ['init', '-b', 'main'], { cwd: memoryDir, stdio: 'inherit' });
    if (gitInit.status === 0) {
      spawnSync('git', ['add', '-A'], { cwd: memoryDir, stdio: 'inherit' });
      spawnSync('git', ['commit', '-m', 'initial memory'], { cwd: memoryDir, stdio: 'inherit' });
      info('initialised git repo in memory dir');
    } else {
      warn('git init failed — memory tool needs a git repo; initialise it manually');
    }
  } else {
    info('memory dir already a git repo — leaving it alone');
  }

  process.stdout.write(
    [
      '',
      'Next steps:',
      `  1. edit ${cfgDst} — fill in feishu appId + uncomment the feishu block if you want the bot`,
      '  2. export ANTHROPIC_API_KEY=... (or configure AWS for Bedrock)',
      '  3. pnpm chat     # local REPL, no feishu needed',
      '  4. pnpm start    # connects to feishu (needs the feishu block enabled)',
      '',
    ].join('\n'),
  );
}

function argOr(argv: readonly string[], flag: string, fallback: string): string {
  const idx = argv.indexOf(flag);
  if (idx < 0) return fallback;
  const next = argv[idx + 1];
  if (!next) die(`${flag} requires a value`);
  return resolve(next);
}

function info(msg: string): void {
  process.stdout.write(`[init] ${msg}\n`);
}
function warn(msg: string): void {
  process.stderr.write(`[init] WARN: ${msg}\n`);
}
function die(msg: string): never {
  process.stderr.write(`[init] ERROR: ${msg}\n`);
  process.exit(1);
}

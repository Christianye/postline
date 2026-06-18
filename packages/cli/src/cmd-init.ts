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
        'Usage: postline init [--repo <path>] [--memory <path>] [--channel <telegram|slack|feishu>]',
        '',
        '  Idempotent: safe to re-run. Existing files are never overwritten.',
        '  --channel tailors the printed next-steps to your IM (default telegram).',
        '',
      ].join('\n'),
    );
    return;
  }

  const repoDir = argOr(argv, '--repo', process.env.POSTLINE_REPO_DIR ?? process.cwd());
  const memoryDir = argOr(argv, '--memory', resolve(homedir(), '.postline', 'memory'));
  const channel = parseChannel(rawArg(argv, '--channel') ?? 'telegram');

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

  const routingMd = resolve(memoryDir, 'routing.md');
  if (!existsSync(routingMd)) {
    writeFileSync(routingMd, STARTER_ROUTING_MD);
    info(`created ${routingMd} — edit worker_aliases to point at your repos`);
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

  process.stdout.write(nextSteps(channel, cfgDst));
}

/** Starter routing.md dropped into the memory dir. Mirrors
 *  docs/routing.example.md — edit worker_aliases for your own repos. */
const STARTER_ROUTING_MD = `# routing.md

How postline routes inbound messages. See docs/routing.example.md for the
full annotated template. Edit worker_aliases to point at your repos; the
bridge hot-reloads on save.

## wake
pl

## projects
- myrepo

## worker_aliases
myrepo → /path/to/myrepo

## dispatch_to_mac
- path token: ~/, ./, *.ts, *.py, *.go, *.md
- repo verbs: repo, branch, commit, "PR #", merge, git
- explicit verbs: review, debug, refactor

## destructive_verbs
- deploy
- "rm -rf"
- "force push"
- "git push --force"
`;

type Channel = 'telegram' | 'slack' | 'feishu';

function parseChannel(v: string): Channel {
  if (v === 'telegram' || v === 'slack' || v === 'feishu') return v;
  die(`--channel must be one of telegram|slack|feishu (got "${v}")`);
}

/** Channel-specific bridge command + token env + config block to uncomment. */
const CHANNEL_SETUP: Record<Channel, { bridge: string; tokenStep: string; configHint: string }> = {
  telegram: {
    bridge: 'postline telegram',
    tokenStep: 'export CC_TELEGRAM_BOT_TOKEN=...   # from @BotFather',
    configHint: 'uncomment the `telegram` block (+ add your numeric id to allowlist)',
  },
  slack: {
    bridge: 'postline slack',
    tokenStep: 'export CC_SLACK_APP_TOKEN=xapp-... CC_SLACK_BOT_TOKEN=xoxb-...',
    configHint: 'uncomment the `slack` block (+ add your Slack user id to allowlist)',
  },
  feishu: {
    bridge: 'postline feishu',
    tokenStep: 'export POSTLINE_FEISHU_APP_SECRET=...   # + set appId in config',
    configHint: 'uncomment the `feishu` block (fill appId)',
  },
};

function nextSteps(channel: Channel, cfgDst: string): string {
  const s = CHANNEL_SETUP[channel];
  return `${[
    '',
    `Next steps (${channel} bridge → dispatch to a cc-worker):`,
    `  1. edit ${cfgDst} — ${s.configHint};`,
    '     also uncomment the `doorbell` block (enables dispatch to workers).',
    '     then edit routing.md in your memory dir — point worker_aliases at',
    '     your repos (a starter was just created; see docs/routing.example.md).',
    '  2. set credentials:',
    `       ${s.tokenStep}`,
    '       export ANTHROPIC_API_KEY=...        # or configure AWS for Bedrock',
    '       export CC_DOORBELL_SECRET=$(openssl rand -hex 32)   # shared bridge⇄worker',
    '  3. start the bridge:',
    `       ${s.bridge}`,
    '  4. in another terminal, register this repo as a worker:',
    '       export CC_DOORBELL_URL=http://localhost:9999',
    '       export CC_DOORBELL_SECRET=<same as step 2>',
    '       postline cc-worker start',
    '  5. verify + test:',
    '       postline doctor          # should show: doorbell up, 1 worker',
    `       # then DM your bot:  !pl@${baseName(cfgDst)} echo hi`,
    '',
    '  (local REPL without any IM:  pnpm chat)',
    '',
  ].join('\n')}`;
}

function baseName(p: string): string {
  return resolve(p, '..').split('/').pop() ?? 'repo';
}

function argOr(argv: readonly string[], flag: string, fallback: string): string {
  const idx = argv.indexOf(flag);
  if (idx < 0) return fallback;
  const next = argv[idx + 1];
  if (!next) die(`${flag} requires a value`);
  return resolve(next);
}

/** Like argOr but returns the raw value (no path resolution) — for keyword flags. */
function rawArg(argv: readonly string[], flag: string): string | undefined {
  const idx = argv.indexOf(flag);
  if (idx < 0) return undefined;
  const next = argv[idx + 1];
  if (!next) die(`${flag} requires a value`);
  return next;
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

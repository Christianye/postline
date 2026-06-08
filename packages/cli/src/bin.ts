#!/usr/bin/env node
import { runAsk } from './cmd-ask.js';
import { runCcWorker } from './cmd-cc-worker.js';
import { runChat } from './cmd-chat.js';
import { runDailyReport } from './cmd-daily-report.js';
import { runDoctor } from './cmd-doctor.js';
import { runFeishu } from './cmd-feishu.js';
import { runInit } from './cmd-init.js';
import { runStats } from './cmd-stats.js';
import { runTools } from './cmd-tools.js';
import { runUpgrade } from './cmd-upgrade.js';

const cmd = process.argv[2] ?? 'chat';
const rest = process.argv.slice(3);

async function main(): Promise<void> {
  switch (cmd) {
    case 'chat':
      await runChat();
      break;
    case 'feishu':
      await runFeishu();
      break;
    case 'ask':
      await runAsk(rest);
      break;
    case 'upgrade':
      await runUpgrade(rest);
      break;
    case 'doctor':
      await runDoctor(rest);
      break;
    case 'init':
      await runInit(rest);
      break;
    case 'tools':
      await runTools(rest);
      break;
    case 'stats':
      await runStats(rest);
      break;
    case 'daily-report':
      await runDailyReport(rest);
      break;
    case 'cc-worker':
      await runCcWorker(rest);
      break;
    case '--version':
    case '-V':
      process.stdout.write('postline 0.4.0\n');
      break;
    case '--help':
    case '-h':
    case 'help':
      process.stdout.write(
        [
          'Usage: postline <command>',
          '',
          'Commands:',
          '  chat      Start an interactive REPL against the configured provider',
          '  feishu    Connect to Feishu as a bot and serve the configured group(s)',
          '  ask       Run a single turn (one prompt → one reply) and exit; for cron / scripts',
          '  upgrade   Pull latest main, reinstall, rebuild, restart cc.service if active',
          '  doctor    Check local env — Node/pnpm/git/creds/config/memory dir',
          '  init      Scaffold postline.config.ts + memory dir (idempotent)',
          '  tools     List every tool the turn runner would receive (builtin + MCP + skills)',
          '  stats     Aggregate token + estimated $ usage from usage.jsonl',
          '  daily-report   Build a markdown digest of yesterday and (optionally) feishu_send it',
          '  cc-worker  Register this CC session as a doorbell worker (start | stop | status)',
          '',
          'Flags:',
          '  --version, -V  print version and exit',
          '  --help, -h     print this help',
          '',
          'Run `postline <command> --help` for per-command options.',
          '',
        ].join('\n'),
      );
      break;
    default:
      process.stderr.write(`unknown command: ${cmd}\n`);
      process.stderr.write('run `postline --help` for the command list\n');
      process.exit(1);
  }
}

main().catch((err) => {
  process.stderr.write(`fatal: ${(err as Error).message}\n`);
  process.exit(1);
});

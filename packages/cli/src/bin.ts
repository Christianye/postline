#!/usr/bin/env node
import { runChat } from './cmd-chat.js';
import { runFeishu } from './cmd-feishu.js';

const cmd = process.argv[2] ?? 'chat';

async function main(): Promise<void> {
  switch (cmd) {
    case 'chat':
      await runChat();
      break;
    case 'feishu':
      await runFeishu();
      break;
    case '--help':
    case '-h':
    case 'help':
      process.stdout.write(
        [
          'Usage: postline <command>',
          '',
          'Commands:',
          '  chat     Start an interactive REPL against the configured provider',
          '  feishu   Connect to Feishu as a bot and serve the configured group(s)',
          '',
        ].join('\n'),
      );
      break;
    default:
      process.stderr.write(`unknown command: ${cmd}\n`);
      process.exit(1);
  }
}

main().catch((err) => {
  process.stderr.write(`fatal: ${(err as Error).message}\n`);
  process.exit(1);
});

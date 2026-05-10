import { randomUUID } from 'node:crypto';
import { loadPostlineConfig, validateConfig } from '@postline/config';
import { type InboundMessage, type Tool, createLogger, runTurn } from '@postline/core';
import { createProvider } from '@postline/providers';
import { createBuiltinTools } from '@postline/tools-builtin';
import { createMemoryHistory } from './history-memory.js';
import { createFsMemory } from './memory-fs.js';

/**
 * `postline ask <prompt>`: single-turn runner for cron / scripts. Loads the
 * same config as `chat` / `feishu`, runs one `runTurn`, prints the final
 * assistant text to stdout, and exits 0 on success, non-zero on failure.
 *
 * The prompt can be:
 *   - a single string arg:          postline ask "summarise recent PRs"
 *   - stdin (when no args):         echo "..." | postline ask
 *   - multi-arg joined with spaces: postline ask summarise recent PRs
 *
 * `approveDangerous` auto-denies. Use this for workflows with `read` + `write`
 * tools only (e.g. feishu_send + gh_query + bash_read). Dangerous tools will
 * show up as denied in the transcript.
 */
export async function runAsk(argv: readonly string[]): Promise<void> {
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(
      [
        'Usage: postline ask [prompt...] [--user <open_id>]',
        '',
        '  Runs a single turn against the configured provider + tools,',
        '  prints the final assistant text to stdout, exits 0 on success.',
        '',
        '  prompt...        the user message (joined with spaces). If empty,',
        '                   reads from stdin.',
        '  --user <open_id> pretend the turn originated from this user, for',
        '                   allowlist checks. Default: ou_cli_ask.',
        '',
        '  Dangerous-tier tools are auto-denied in `ask`. Chain with cron or',
        '  shell scripts for scheduled workflows (see examples/daily-report).',
        '',
      ].join('\n'),
    );
    return;
  }

  // Parse --user out of argv, then join the rest as the prompt.
  const args = [...argv];
  let userId = 'ou_cli_ask';
  const userIdx = args.indexOf('--user');
  if (userIdx >= 0) {
    const next = args[userIdx + 1];
    if (!next) {
      process.stderr.write('fatal: --user requires a value\n');
      process.exit(1);
    }
    userId = next;
    args.splice(userIdx, 2);
  }

  const promptFromArgs = args.join(' ').trim();
  const prompt = promptFromArgs.length > 0 ? promptFromArgs : await readStdin();
  if (!prompt.trim()) {
    process.stderr.write('fatal: no prompt provided (pass as args or via stdin)\n');
    process.exit(1);
  }

  const cfg = await loadPostlineConfig();
  const errors = validateConfig(cfg);
  if (errors.length > 0) {
    process.stderr.write(`invalid config:\n${errors.map((e) => `  - ${e}`).join('\n')}\n`);
    process.exit(2);
  }

  const log = createLogger({ level: cfg.logging?.level ?? 'info' });
  const allowlist = new Set<string>([...cfg.allowlist.openIds, userId]);

  const provider = createProvider(cfg.provider, {
    log,
    ...(cfg.fallbacks ? { fallbacks: cfg.fallbacks } : {}),
  });
  const memory = createFsMemory(cfg.memory.dir);
  const history = createMemoryHistory();

  const tools = new Map<string, Tool>();
  for (const t of createBuiltinTools(cfg.tools.builtin, cfg.tools.options ?? {}, {
    memoryDir: cfg.memory.dir,
    ...(cfg.feishu ? { feishu: { appId: cfg.feishu.appId, appSecret: cfg.feishu.appSecret } } : {}),
  })) {
    tools.set(t.name, t);
  }

  const inbound: InboundMessage = {
    id: randomUUID(),
    userId,
    conversationId: 'cli-ask',
    text: prompt,
    receivedAt: Date.now(),
  };

  const ac = new AbortController();
  const onSig = () => ac.abort();
  process.on('SIGINT', onSig);
  try {
    const reply = await runTurn(
      inbound,
      {
        model: cfg.model,
        maxIterations: 8,
        allowlist,
        historyLimit: 20,
        log,
        approveDangerous: async (tool) => {
          log.warn({ tool: tool.name }, 'ask_auto_denied_dangerous_tool');
          return false;
        },
      },
      { provider, tools, memory, history },
      ac.signal,
    );
    process.stdout.write(`${reply}\n`);
  } finally {
    process.off('SIGINT', onSig);
  }
}

function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    if (process.stdin.isTTY) {
      // No stdin piped and no args — return empty so the caller can error out.
      resolve('');
      return;
    }
    const chunks: Buffer[] = [];
    process.stdin.on('data', (c: Buffer) => chunks.push(c));
    process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    process.stdin.on('error', reject);
  });
}

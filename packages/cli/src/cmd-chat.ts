import { createCliChannel } from '@postline/adapters-cli';
import { loadPostlineConfig, validateConfig } from '@postline/config';
import { type InboundMessage, type Tool, createLogger, runTurn } from '@postline/core';
import { createProvider } from '@postline/providers';
import { createBuiltinTools } from '@postline/tools-builtin';
import { createMemoryHistory } from './history-memory.js';
import { createFsMemory } from './memory-fs.js';

export async function runChat(): Promise<void> {
  const cfg = await loadPostlineConfig();
  const errors = validateConfig(cfg);
  if (errors.length > 0) {
    process.stderr.write(`invalid config:\n${errors.map((e) => `  - ${e}`).join('\n')}\n`);
    process.exit(2);
  }

  const log = createLogger({ level: cfg.logging?.level ?? 'info' });

  const cliUserId = 'ou_cli_local';
  const allowlist = new Set<string>([...cfg.allowlist.openIds, cliUserId]);

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

  const { channel, ask } = createCliChannel({ userId: cliUserId, prompt: 'you> ' });
  process.stdout.write(
    `postline chat — model=${cfg.model}, provider=${cfg.provider.name}, tools=${tools.size}\n`,
  );
  process.stdout.write('type /exit to quit.\n\n');

  const stop = channel.listen(async (inbound: InboundMessage) => {
    const ac = new AbortController();
    const onSig = () => ac.abort();
    process.on('SIGINT', onSig);
    try {
      const reply = await runTurn(
        inbound,
        {
          model: cfg.model,
          maxIterations: 6,
          allowlist,
          historyLimit: 40,
          log,
          approveDangerous: async (tool, args) => {
            const answer = await ask(
              `\n[approve] tool=${tool.name} args=${JSON.stringify(args).slice(0, 200)}\n[approve] y to run, anything else to deny: `,
            );
            return answer.trim().toLowerCase() === 'y';
          },
        },
        { provider, tools, memory, history },
        ac.signal,
      );
      await channel.send({ conversationId: inbound.conversationId, text: `CC: ${reply}` });
    } finally {
      process.off('SIGINT', onSig);
    }
  });

  await stop;
}

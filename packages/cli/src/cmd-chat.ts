import { createCliChannel } from '@postline/adapters-cli';
import { createLogger, runTurn, type InboundMessage, type Tool } from '@postline/core';
import { BedrockProvider } from '@postline/providers';
import { createBashTool, createEchoTool } from '@postline/tools-builtin';
import { loadConfig } from './config.js';
import { createFsMemory } from './memory-fs.js';
import { createMemoryHistory } from './history-memory.js';

export async function runChat(): Promise<void> {
  const cfg = loadConfig();
  const log = createLogger({ level: cfg.logLevel });

  const cliUserId = 'ou_cli_local';
  const allowlist = new Set<string>([...cfg.allowlist, cliUserId]);

  const provider = new BedrockProvider({
    region: cfg.region,
    log,
    fallbacks: cfg.fallbacks,
  });
  const memory = createFsMemory(cfg.memoryDir);
  const history = createMemoryHistory();

  const tools = new Map<string, Tool>();
  const bash = createBashTool({ risk: 'dangerous', timeoutMs: 30_000 });
  const echo = createEchoTool();
  tools.set(bash.name, bash);
  tools.set(echo.name, echo);

  const { channel, ask } = createCliChannel({ userId: cliUserId, prompt: 'the operator> ' });
  process.stdout.write(`postline chat — model=${cfg.model}, region=${cfg.region}\n`);
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

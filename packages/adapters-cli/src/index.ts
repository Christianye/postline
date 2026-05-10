import { randomUUID } from 'node:crypto';
import { type Interface as ReadlineInterface, createInterface } from 'node:readline';
import type { Channel, InboundMessage, OutboundMessage } from '@postline/core';

export interface CliAdapterOptions {
  userId: string;
  conversationId?: string;
  prompt?: string;
}

export interface CliSession {
  channel: Channel;
  /**
   * Consume exactly one upcoming line from stdin (intended for tool approval prompts).
   * The line reader queue pauses until this resolves.
   */
  ask(question: string): Promise<string>;
}

type LineResolver = (line: string | null) => void;

/**
 * A Channel + interactive prompt that share one readline instance.
 * All lines funnel through an internal queue processed serially,
 * so a running handler (or an ask()) cannot be stepped on by the next line.
 */
export function createCliChannel(opts: CliAdapterOptions): CliSession {
  const conversationId = opts.conversationId ?? 'cli-local';
  const prompt = opts.prompt ?? '> ';
  let rl: ReadlineInterface | null = null;
  let closed = false;
  const pending: string[] = [];
  const waiters: LineResolver[] = [];

  function pushLine(line: string): void {
    const waiter = waiters.shift();
    if (waiter) waiter(line);
    else pending.push(line);
  }

  function nextLine(): Promise<string | null> {
    if (closed && pending.length === 0) return Promise.resolve(null);
    const line = pending.shift();
    if (line !== undefined) return Promise.resolve(line);
    return new Promise((resolve) => waiters.push(resolve));
  }

  function resolveAllNull(): void {
    while (waiters.length > 0) {
      const w = waiters.shift();
      if (w) w(null);
    }
  }

  const channel: Channel = {
    name: 'cli',
    listen(onMessage) {
      rl = createInterface({ input: process.stdin, output: process.stdout, prompt });
      rl.prompt();
      rl.on('line', (line) => pushLine(line));
      const done = new Promise<void>((resolve) =>
        rl?.on('close', () => {
          closed = true;
          resolveAllNull();
          resolve();
        }),
      );

      // Worker loop: consume one line at a time.
      (async () => {
        while (!closed) {
          const line = await nextLine();
          if (line === null) break;
          const text = line.trim();
          if (!text) {
            rl?.prompt();
            continue;
          }
          if (text === '/exit' || text === '/quit') {
            closed = true;
            rl?.close();
            break;
          }
          const msg: InboundMessage = {
            id: randomUUID(),
            userId: opts.userId,
            conversationId,
            text,
            receivedAt: Date.now(),
          };
          try {
            await onMessage(msg);
          } catch (e) {
            process.stderr.write(`\n[error] ${(e as Error).message}\n`);
          }
          if (!closed) rl?.prompt();
        }
      })();

      return async () => {
        closed = true;
        rl?.close();
        resolveAllNull();
        await done;
      };
    },
    async send(msg: OutboundMessage) {
      process.stdout.write(`\n${msg.text}\n`);
    },
    async health() {
      return { ok: true };
    },
  };

  async function ask(question: string): Promise<string> {
    if (!rl) throw new Error('ask() called before listen()');
    process.stdout.write(question);
    const line = await nextLine();
    return line ?? '';
  }

  return { channel, ask };
}

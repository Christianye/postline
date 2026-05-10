import { describe, expect, it } from 'vitest';
import { createLogger } from './logger.js';
import { runTurn } from './turn.js';
import type {
  HistoryStore,
  InboundMessage,
  Memory,
  Message,
  Provider,
  StreamChunk,
  Tool,
} from './types.js';

function mockProvider(chunks: StreamChunk[][]): Provider {
  let call = 0;
  return {
    name: 'mock',
    async *stream() {
      const batch = chunks[call++] ?? [];
      for (const c of batch) yield c;
    },
  };
}

const memory: Memory = {
  async load() {
    return 'memory content';
  },
  async write() {},
  async read() {
    return null;
  },
};

class InMemoryHistory implements HistoryStore {
  private store = new Map<string, Message[]>();
  async load(cid: string) {
    return this.store.get(cid) ?? [];
  }
  async append(cid: string, msgs: Message[]) {
    const cur = this.store.get(cid) ?? [];
    this.store.set(cid, [...cur, ...msgs]);
  }
}

const inbound: InboundMessage = {
  id: 't1',
  userId: 'ou_me',
  conversationId: 'oc_1',
  text: 'hi',
  receivedAt: 0,
};

const log = createLogger({ level: 'silent' });

describe('runTurn', () => {
  it('returns final text when model emits no tool_use', async () => {
    const provider = mockProvider([
      [{ type: 'text_delta', text: 'Hello!' }, { type: 'done', stopReason: 'stop' }],
    ]);
    const text = await runTurn(
      inbound,
      {
        model: 'test',
        maxIterations: 3,
        allowlist: new Set(['ou_me']),
        historyLimit: 10,
        log,
      },
      { provider, tools: new Map(), memory, history: new InMemoryHistory() },
      AbortSignal.timeout(5000),
    );
    expect(text).toBe('Hello!');
  });

  it('loops through one tool call then returns final text', async () => {
    const provider = mockProvider([
      [
        { type: 'text_delta', text: 'let me check' },
        {
          type: 'tool_use_end',
          toolUse: { type: 'tool_use', id: 'tu1', name: 'echo', input: { msg: 'hi' } },
        },
        { type: 'done', stopReason: 'tool_use' },
      ],
      [{ type: 'text_delta', text: 'got: hi' }, { type: 'done', stopReason: 'stop' }],
    ]);
    const echoTool: Tool = {
      name: 'echo',
      description: 'echo',
      inputSchema: { type: 'object' },
      risk: 'read',
      async run(args) {
        return { content: String(args.msg) };
      },
    };
    const text = await runTurn(
      inbound,
      {
        model: 'test',
        maxIterations: 3,
        allowlist: new Set(['ou_me']),
        historyLimit: 10,
        log,
      },
      {
        provider,
        tools: new Map([['echo', echoTool]]),
        memory,
        history: new InMemoryHistory(),
      },
      AbortSignal.timeout(5000),
    );
    expect(text).toBe('got: hi');
  });

  it('blocks write tool for non-allowlist user', async () => {
    const calls: Record<string, unknown>[] = [];
    const provider = mockProvider([
      [
        {
          type: 'tool_use_end',
          toolUse: { type: 'tool_use', id: 'tu1', name: 'delete', input: {} },
        },
        { type: 'done', stopReason: 'tool_use' },
      ],
      [{ type: 'text_delta', text: 'blocked' }, { type: 'done', stopReason: 'stop' }],
    ]);
    const deleteTool: Tool = {
      name: 'delete',
      description: 'delete',
      inputSchema: { type: 'object' },
      risk: 'write',
      async run(args) {
        calls.push(args);
        return { content: 'deleted' };
      },
    };
    await runTurn(
      { ...inbound, userId: 'ou_stranger' },
      {
        model: 'test',
        maxIterations: 3,
        allowlist: new Set(['ou_me']),
        historyLimit: 10,
        log,
      },
      {
        provider,
        tools: new Map([['delete', deleteTool]]),
        memory,
        history: new InMemoryHistory(),
      },
      AbortSignal.timeout(5000),
    );
    expect(calls).toHaveLength(0);
  });
});

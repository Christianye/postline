import { describe, expect, it } from 'vitest';
import { createLogger } from './logger.js';
import { createPostlineMetrics } from './metrics.js';
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
      [
        { type: 'text_delta', text: 'Hello!' },
        { type: 'done', stopReason: 'stop' },
      ],
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
      [
        { type: 'text_delta', text: 'got: hi' },
        { type: 'done', stopReason: 'stop' },
      ],
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

  it('injects synthetic tool_result when stream errors mid-tool_use', async () => {
    // Provider yields a tool_use block but the stream ends with stopReason='error'
    // (e.g. transient bedrock failure, or all fallbacks exhausted). The turn must
    // append a synthetic isError tool_result so persisted history stays well-formed.
    const provider = mockProvider([
      [
        { type: 'text_delta', text: 'about to call bash' },
        {
          type: 'tool_use_end',
          toolUse: { type: 'tool_use', id: 'tu_orphan', name: 'bash', input: { cmd: 'echo hi' } },
        },
        { type: 'error', error: 'simulated stream failure' },
      ],
    ]);
    const bashTool: Tool = {
      name: 'bash',
      description: 'bash',
      inputSchema: { type: 'object' },
      risk: 'dangerous',
      async run() {
        return { content: 'should not run' };
      },
    };
    const history = new InMemoryHistory();
    await runTurn(
      inbound,
      {
        model: 'test',
        maxIterations: 3,
        allowlist: new Set(['ou_me']),
        historyLimit: 10,
        log,
        approveDangerous: async () => true,
      },
      {
        provider,
        tools: new Map([['bash', bashTool]]),
        memory,
        history,
      },
      AbortSignal.timeout(5000),
    );
    const persisted = await history.load(inbound.conversationId);
    // Find the assistant message with tool_use
    const assistantIdx = persisted.findIndex(
      (m) => m.role === 'assistant' && m.content.some((c) => c.type === 'tool_use'),
    );
    expect(assistantIdx).toBeGreaterThanOrEqual(0);
    const next = persisted[assistantIdx + 1];
    expect(next?.role).toBe('tool');
    const result = next?.content[0];
    expect(result?.type).toBe('tool_result');
    if (result?.type === 'tool_result') {
      expect(result.toolUseId).toBe('tu_orphan');
      expect(result.isError).toBe(true);
    }
  });

  it('forwards provider status chunks to the onStatus hook', async () => {
    const provider = mockProvider([
      [
        { type: 'status', status: { kind: 'attempt_started', detail: 'mock-model' } },
        { type: 'status', status: { kind: 'thinking' } },
        { type: 'text_delta', text: 'hi' },
        { type: 'done', stopReason: 'stop' },
      ],
    ]);
    const events: Array<{ kind: string; detail?: string; iter: number }> = [];
    await runTurn(
      inbound,
      {
        model: 'test',
        maxIterations: 3,
        allowlist: new Set(['ou_me']),
        historyLimit: 10,
        log,
        onStatus: (s) =>
          events.push({ kind: s.kind, ...(s.detail ? { detail: s.detail } : {}), iter: s.iter }),
      },
      { provider, tools: new Map(), memory, history: new InMemoryHistory() },
      AbortSignal.timeout(5000),
    );
    expect(events).toEqual([
      { kind: 'attempt_started', detail: 'mock-model', iter: 0 },
      { kind: 'thinking', iter: 0 },
    ]);
  });

  it('emits tool_running status before invoking a tool', async () => {
    const provider = mockProvider([
      [
        {
          type: 'tool_use_end',
          toolUse: { type: 'tool_use', id: 'tu1', name: 'echo', input: {} },
        },
        { type: 'done', stopReason: 'tool_use' },
      ],
      [
        { type: 'text_delta', text: 'done' },
        { type: 'done', stopReason: 'stop' },
      ],
    ]);
    const echoTool: Tool = {
      name: 'echo',
      description: 'echo',
      inputSchema: { type: 'object' },
      risk: 'read',
      async run() {
        return { content: 'ok' };
      },
    };
    const events: Array<{ kind: string; detail?: string }> = [];
    await runTurn(
      inbound,
      {
        model: 'test',
        maxIterations: 3,
        allowlist: new Set(['ou_me']),
        historyLimit: 10,
        log,
        onStatus: (s) => events.push({ kind: s.kind, ...(s.detail ? { detail: s.detail } : {}) }),
      },
      {
        provider,
        tools: new Map([['echo', echoTool]]),
        memory,
        history: new InMemoryHistory(),
      },
      AbortSignal.timeout(5000),
    );
    expect(events).toContainEqual({ kind: 'tool_running', detail: 'echo' });
  });

  it('does not crash the turn when onStatus throws', async () => {
    const provider = mockProvider([
      [
        { type: 'status', status: { kind: 'thinking' } },
        { type: 'text_delta', text: 'reply' },
        { type: 'done', stopReason: 'stop' },
      ],
    ]);
    const text = await runTurn(
      inbound,
      {
        model: 'test',
        maxIterations: 3,
        allowlist: new Set(['ou_me']),
        historyLimit: 10,
        log,
        onStatus: () => {
          throw new Error('hook explosion');
        },
      },
      { provider, tools: new Map(), memory, history: new InMemoryHistory() },
      AbortSignal.timeout(5000),
    );
    expect(text).toBe('reply');
  });

  it('bumps turn_total{outcome=success} + tool_total + tool_duration_ms when wired with metrics', async () => {
    const provider = mockProvider([
      [
        {
          type: 'tool_use_end',
          toolUse: { type: 'tool_use', id: 'tu1', name: 'echo', input: {} },
        },
        { type: 'done', stopReason: 'tool_use' },
      ],
      [
        { type: 'text_delta', text: 'done' },
        { type: 'done', stopReason: 'stop' },
      ],
    ]);
    const echoTool: Tool = {
      name: 'echo',
      description: 'echo',
      inputSchema: { type: 'object' },
      risk: 'read',
      async run() {
        return { content: 'ok' };
      },
    };
    const metrics = createPostlineMetrics();
    await runTurn(
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
        metrics,
      },
      AbortSignal.timeout(5000),
    );
    const snap = metrics.dump();
    const turnTotal = snap.counters.find((c) => c.name === 'turn_total');
    expect(turnTotal?.series).toContainEqual({ labels: { outcome: 'success' }, value: 1 });
    const toolTotal = snap.counters.find((c) => c.name === 'tool_total');
    expect(toolTotal?.series).toContainEqual({
      labels: { name: 'echo', outcome: 'ok' },
      value: 1,
    });
    const toolDuration = snap.histograms.find((h) => h.name === 'tool_duration_ms');
    expect(toolDuration?.series).toHaveLength(1);
    expect(toolDuration?.series[0]?.count).toBe(1);
  });

  it('records turn_total{outcome=error} when stream errors out', async () => {
    const provider = mockProvider([
      [
        { type: 'text_delta', text: 'partial' },
        { type: 'error', error: 'simulated' },
      ],
    ]);
    const metrics = createPostlineMetrics();
    await runTurn(
      inbound,
      {
        model: 'test',
        maxIterations: 3,
        allowlist: new Set(['ou_me']),
        historyLimit: 10,
        log,
      },
      { provider, tools: new Map(), memory, history: new InMemoryHistory(), metrics },
      AbortSignal.timeout(5000),
    );
    const turnTotal = metrics.dump().counters.find((c) => c.name === 'turn_total');
    expect(turnTotal?.series).toContainEqual({ labels: { outcome: 'error' }, value: 1 });
  });

  it('forwards provider thinking_delta chunks to the onThinkingDelta hook', async () => {
    const provider = mockProvider([
      [
        { type: 'thinking_delta', thinking: 'Let me ' },
        { type: 'thinking_delta', thinking: 'reason about this. ' },
        { type: 'text_delta', text: 'answer' },
        { type: 'done', stopReason: 'stop' },
      ],
    ]);
    const events: Array<{ delta: string; accumulated: string; iter: number }> = [];
    await runTurn(
      inbound,
      {
        model: 'test',
        maxIterations: 3,
        allowlist: new Set(['ou_me']),
        historyLimit: 10,
        log,
        thinking: { enabled: true, effort: 'high' },
        onThinkingDelta: (c) => events.push(c),
      },
      { provider, tools: new Map(), memory, history: new InMemoryHistory() },
      AbortSignal.timeout(5000),
    );
    expect(events).toHaveLength(2);
    expect(events[0]?.delta).toBe('Let me ');
    expect(events[0]?.accumulated).toBe('Let me ');
    expect(events[1]?.accumulated).toBe('Let me reason about this. ');
  });

  it('thinking_delta chunks do NOT enter persisted history', async () => {
    const provider = mockProvider([
      [
        { type: 'thinking_delta', thinking: 'pondering...' },
        { type: 'text_delta', text: 'answer' },
        { type: 'done', stopReason: 'stop' },
      ],
    ]);
    const history = new InMemoryHistory();
    await runTurn(
      inbound,
      {
        model: 'test',
        maxIterations: 3,
        allowlist: new Set(['ou_me']),
        historyLimit: 10,
        log,
        thinking: { enabled: true },
      },
      { provider, tools: new Map(), memory, history },
      AbortSignal.timeout(5000),
    );
    const persisted = await history.load(inbound.conversationId);
    // No row may carry the word "pondering" — thinking is intentionally
    // dropped from history so each turn's reasoning is independent.
    const allText = JSON.stringify(persisted);
    expect(allText).not.toContain('pondering');
    expect(allText).toContain('answer');
  });

  it('does not crash the turn when onThinkingDelta throws', async () => {
    const provider = mockProvider([
      [
        { type: 'thinking_delta', thinking: 'oops' },
        { type: 'text_delta', text: 'reply' },
        { type: 'done', stopReason: 'stop' },
      ],
    ]);
    const text = await runTurn(
      inbound,
      {
        model: 'test',
        maxIterations: 3,
        allowlist: new Set(['ou_me']),
        historyLimit: 10,
        log,
        thinking: { enabled: true },
        onThinkingDelta: () => {
          throw new Error('hook explosion');
        },
      },
      { provider, tools: new Map(), memory, history: new InMemoryHistory() },
      AbortSignal.timeout(5000),
    );
    expect(text).toBe('reply');
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
      [
        { type: 'text_delta', text: 'blocked' },
        { type: 'done', stopReason: 'stop' },
      ],
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

import Anthropic from '@anthropic-ai/sdk';
import type {
  ContentPart,
  Logger,
  Message,
  Provider,
  StreamChunk,
  ToolSpec,
  ToolUsePart,
  TurnRequest,
} from '@postline/core';

export interface AnthropicProviderOptions {
  log: Logger;
  /** Overrides ANTHROPIC_API_KEY env. */
  apiKey?: string;
  /** Optional base URL (e.g. for self-hosted proxies). */
  baseUrl?: string;
  /** Model ids to try after the primary one fails. */
  fallbacks?: readonly string[];
  /** Per-attempt timeout. Default 180s. */
  timeoutMs?: number;
}

// The Anthropic SDK's message param types are deeply conditional; we rely on
// the SDK validating at runtime and provide our own narrow shape for clarity.
type AnthropicBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | {
      type: 'tool_result';
      tool_use_id: string;
      content: string;
      is_error?: boolean;
    }
  | {
      type: 'image';
      source: {
        type: 'base64';
        media_type: 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';
        data: string;
      };
    };

interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: AnthropicBlock[];
}

/**
 * Strip a `anthropic/` or `anthropic-api/` provider prefix if present.
 * `claude-opus-4-7` and `anthropic/claude-opus-4-7` both work.
 */
function stripProviderPrefix(id: string): string {
  const idx = id.indexOf('/');
  if (idx < 0) return id;
  const prefix = id.slice(0, idx);
  if (prefix === 'anthropic' || prefix === 'anthropic-api') return id.slice(idx + 1);
  return id;
}

function convertMessages(msgs: readonly Message[]): AnthropicMessage[] {
  const out: AnthropicMessage[] = [];
  for (const m of msgs) {
    if (m.role === 'system') continue; // system goes to top-level system field
    if (m.role === 'tool') {
      const blocks: AnthropicBlock[] = [];
      for (const c of m.content) {
        if (c.type !== 'tool_result') continue;
        blocks.push({
          type: 'tool_result',
          tool_use_id: c.toolUseId,
          content: c.content,
          ...(c.isError ? { is_error: true } : {}),
        });
      }
      if (blocks.length > 0) out.push({ role: 'user', content: blocks });
      continue;
    }
    const role: 'user' | 'assistant' = m.role === 'assistant' ? 'assistant' : 'user';
    const blocks = contentPartsToAnthropic(m.content);
    if (blocks.length > 0) out.push({ role, content: blocks });
  }
  return out;
}

function contentPartsToAnthropic(parts: readonly ContentPart[]): AnthropicBlock[] {
  const blocks: AnthropicBlock[] = [];
  for (const c of parts) {
    if (c.type === 'text') {
      blocks.push({ type: 'text', text: c.text });
    } else if (c.type === 'tool_use') {
      blocks.push({
        type: 'tool_use',
        id: c.id,
        name: c.name,
        input: c.input,
      });
    } else if (c.type === 'image') {
      blocks.push({
        type: 'image',
        source: {
          type: 'base64',
          media_type: c.mimeType,
          data: c.data,
        },
      });
    }
    // tool_result handled at message level above
  }
  return blocks;
}

function convertTools(tools: readonly ToolSpec[]) {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.inputSchema as { type: 'object'; [k: string]: unknown },
  }));
}

type AnthropicStopReason = NonNullable<StreamChunk['stopReason']>;
function mapStopReason(r: string | null | undefined): AnthropicStopReason {
  if (r === 'end_turn' || r === 'stop_sequence') return 'stop';
  if (r === 'tool_use') return 'tool_use';
  if (r === 'max_tokens') return 'max_tokens';
  return 'stop';
}

export class AnthropicProvider implements Provider {
  readonly name = 'anthropic';
  private client: Anthropic;
  private log: Logger;
  private fallbacks: readonly string[];
  private timeoutMs: number;

  constructor(opts: AnthropicProviderOptions) {
    this.client = new Anthropic({
      apiKey: opts.apiKey ?? process.env.ANTHROPIC_API_KEY,
      ...(opts.baseUrl ? { baseURL: opts.baseUrl } : {}),
    });
    this.log = opts.log.child({ provider: 'anthropic' });
    this.fallbacks = opts.fallbacks ?? [];
    this.timeoutMs = opts.timeoutMs ?? 180_000;
  }

  async *stream(req: TurnRequest, signal: AbortSignal): AsyncIterable<StreamChunk> {
    const chain = [req.model, ...this.fallbacks];
    let lastError: Error | null = null;
    for (const fullId of chain) {
      const modelId = stripProviderPrefix(fullId);
      this.log.info({ model: modelId }, 'anthropic_attempt');
      try {
        yield* this.streamOne(req, modelId, signal);
        return;
      } catch (e) {
        lastError = e as Error;
        this.log.warn({ model: modelId, error: lastError.message }, 'anthropic_attempt_failed');
        if (signal.aborted) throw lastError;
      }
    }
    yield { type: 'error', error: `All models failed: ${lastError?.message}` };
    yield { type: 'done', stopReason: 'error' };
  }

  private async *streamOne(
    req: TurnRequest,
    modelId: string,
    signal: AbortSignal,
  ): AsyncIterable<StreamChunk> {
    const attemptCtl = new AbortController();
    const onAbort = () => attemptCtl.abort();
    signal.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => attemptCtl.abort(), this.timeoutMs);

    try {
      const stream = this.client.messages.stream(
        {
          model: modelId,
          system: req.system,
          messages: convertMessages(req.messages) as Parameters<
            typeof this.client.messages.stream
          >[0]['messages'],
          ...(req.tools.length > 0 ? { tools: convertTools(req.tools) } : {}),
          max_tokens: req.maxTokens ?? 8192,
          ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
          ...(req.stopSequences && req.stopSequences.length > 0
            ? { stop_sequences: [...req.stopSequences] }
            : {}),
        },
        { signal: attemptCtl.signal },
      );

      // Track partial tool_use state; Anthropic delivers input as incremental
      // partial-JSON deltas inside content_block_delta events.
      const partialToolUses = new Map<number, { id: string; name: string; jsonAccum: string }>();

      for await (const event of stream) {
        switch (event.type) {
          case 'content_block_start': {
            const b = event.content_block;
            if (b.type === 'tool_use') {
              partialToolUses.set(event.index, {
                id: b.id,
                name: b.name,
                jsonAccum: '',
              });
            }
            break;
          }
          case 'content_block_delta': {
            const d = event.delta;
            if (d.type === 'text_delta') {
              yield { type: 'text_delta', text: d.text };
            } else if (d.type === 'input_json_delta') {
              const cur = partialToolUses.get(event.index);
              if (cur) cur.jsonAccum += d.partial_json;
            }
            break;
          }
          case 'content_block_stop': {
            const cur = partialToolUses.get(event.index);
            if (cur) {
              let parsed: Record<string, unknown> = {};
              try {
                parsed = cur.jsonAccum ? JSON.parse(cur.jsonAccum) : {};
              } catch {
                parsed = { __raw: cur.jsonAccum };
              }
              const toolUse: ToolUsePart = {
                type: 'tool_use',
                id: cur.id,
                name: cur.name,
                input: parsed,
              };
              yield { type: 'tool_use_end', toolUse };
              partialToolUses.delete(event.index);
            }
            break;
          }
          case 'message_delta': {
            const r = event.delta.stop_reason;
            if (r) {
              yield { type: 'done', stopReason: mapStopReason(r) };
              return;
            }
            break;
          }
          case 'message_stop':
            // message_delta usually carries stop_reason; fall back here.
            yield { type: 'done', stopReason: 'stop' };
            return;
          // message_start / ping / error handled implicitly
        }
      }
      // Stream ended without explicit stop
      yield { type: 'done', stopReason: 'stop' };
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
    }
  }
}

// Exposed for unit testing
export {
  convertMessages as __convertMessagesForTest,
  stripProviderPrefix as __stripProviderPrefixForTest,
};

import Anthropic from '@anthropic-ai/sdk';
import type {
  ContentPart,
  Logger,
  Message,
  MetricsRegistry,
  Provider,
  StreamChunk,
  ToolSpec,
  ToolUsePart,
  TurnRequest,
} from '@postline/core';
import { withRetry } from '../retry.js';

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
  /** Optional metrics registry. When provided, attempt/retry/fallback events are counted. */
  metrics?: MetricsRegistry;
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
  private metrics?: MetricsRegistry;

  constructor(opts: AnthropicProviderOptions) {
    this.client = new Anthropic({
      apiKey: opts.apiKey ?? process.env.ANTHROPIC_API_KEY,
      ...(opts.baseUrl ? { baseURL: opts.baseUrl } : {}),
    });
    this.log = opts.log.child({ provider: 'anthropic' });
    this.fallbacks = opts.fallbacks ?? [];
    this.timeoutMs = opts.timeoutMs ?? 180_000;
    if (opts.metrics) this.metrics = opts.metrics;
  }

  async *stream(req: TurnRequest, signal: AbortSignal): AsyncIterable<StreamChunk> {
    const chain = [req.model, ...this.fallbacks];
    let lastError: Error | null = null;
    let prevModel: string | undefined;
    for (const fullId of chain) {
      const modelId = stripProviderPrefix(fullId);
      this.log.info({ model: modelId }, 'anthropic_attempt');
      if (prevModel) {
        this.metrics?.inc('provider_fallback_total', {
          provider: 'anthropic',
          from_model: prevModel,
          to_model: modelId,
        });
      }
      try {
        yield* this.streamOne(req, modelId, signal);
        this.metrics?.inc('provider_attempt_total', {
          provider: 'anthropic',
          model: modelId,
          outcome: 'success',
        });
        return;
      } catch (e) {
        lastError = e as Error;
        this.log.warn({ model: modelId, error: lastError.message }, 'anthropic_attempt_failed');
        this.metrics?.inc('provider_attempt_total', {
          provider: 'anthropic',
          model: modelId,
          outcome: 'failure',
        });
        if (signal.aborted) throw lastError;
        prevModel = modelId;
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

    yield { type: 'status', status: { kind: 'attempt_started', detail: modelId } };

    try {
      // Retry only the stream-creation HTTP call. Once we start iterating
      // chunks, any retry would duplicate already-yielded text/tool_use.
      const metrics = this.metrics;
      const stream = await withRetry(
        async () =>
          this.client.messages.stream(
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
              ...(req.thinking?.enabled
                ? {
                    // Adaptive mode is the only mode opus-4-7+ supports;
                    // older models accept it too. `output_config.effort`
                    // is soft guidance. The installed @anthropic-ai/sdk
                    // version still types `thinking.type` as
                    // 'enabled' | 'disabled' only, so the cast through
                    // unknown is required until we bump the SDK.
                    thinking: { type: 'adaptive' } as unknown as {
                      type: 'enabled';
                      budget_tokens: number;
                    },
                    output_config: { effort: req.thinking.effort ?? 'high' },
                  }
                : {}),
            } as Parameters<typeof this.client.messages.stream>[0],
            { signal: attemptCtl.signal },
          ),
        {
          signal: attemptCtl.signal,
          log: this.log,
          logCtx: { provider: 'anthropic', model: modelId },
          ...(metrics
            ? {
                onRetry: () =>
                  metrics.inc('provider_retry_total', { provider: 'anthropic', model: modelId }),
              }
            : {}),
        },
      );

      // Track partial tool_use state; Anthropic delivers input as incremental
      // partial-JSON deltas inside content_block_delta events.
      const partialToolUses = new Map<number, { id: string; name: string; jsonAccum: string }>();
      // Usage arrives in pieces: input-side on message_start, output-side on
      // message_delta. Accumulate and attach to the `done` chunk.
      let inputTokens = 0;
      let outputTokens = 0;
      let cacheReadTokens: number | undefined;
      let cacheCreationTokens: number | undefined;

      const buildUsage = (): StreamChunk['usage'] | undefined => {
        if (inputTokens === 0 && outputTokens === 0) return undefined;
        return {
          inputTokens,
          outputTokens,
          ...(cacheReadTokens !== undefined ? { cacheReadTokens } : {}),
          ...(cacheCreationTokens !== undefined ? { cacheCreationTokens } : {}),
        };
      };

      for await (const event of stream) {
        switch (event.type) {
          case 'message_start': {
            const u = event.message.usage as
              | {
                  input_tokens?: number;
                  cache_read_input_tokens?: number;
                  cache_creation_input_tokens?: number;
                }
              | undefined;
            if (u) {
              if (typeof u.input_tokens === 'number') inputTokens = u.input_tokens;
              if (typeof u.cache_read_input_tokens === 'number')
                cacheReadTokens = u.cache_read_input_tokens;
              if (typeof u.cache_creation_input_tokens === 'number')
                cacheCreationTokens = u.cache_creation_input_tokens;
            }
            // Stream open, no content blocks yet — heartbeat so the host
            // can swap a placeholder before the first text_delta arrives.
            yield { type: 'status', status: { kind: 'thinking' } };
            break;
          }
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
            const d = event.delta as
              | { type: 'text_delta'; text: string }
              | { type: 'input_json_delta'; partial_json: string }
              | { type: 'thinking_delta'; thinking: string }
              | { type: 'signature_delta'; signature: string }
              | { type: string };
            if (d.type === 'text_delta' && 'text' in d) {
              yield { type: 'text_delta', text: d.text };
            } else if (d.type === 'input_json_delta' && 'partial_json' in d) {
              const cur = partialToolUses.get(event.index);
              if (cur) cur.jsonAccum += d.partial_json;
            } else if (d.type === 'thinking_delta' && 'thinking' in d) {
              // Extended-thinking streaming. We surface text only; the
              // signature_delta that pairs with it is needed by Anthropic
              // only when echoing thinking blocks back in multi-turn —
              // postline's scope (c) intentionally drops thinking from
              // history, so we ignore signatures.
              yield { type: 'thinking_delta', thinking: d.thinking };
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
            // Output-side usage arrives here.
            const u = event.usage as { output_tokens?: number } | undefined;
            if (u && typeof u.output_tokens === 'number') outputTokens = u.output_tokens;
            const r = event.delta.stop_reason;
            if (r) {
              const usage = buildUsage();
              yield {
                type: 'done',
                stopReason: mapStopReason(r),
                ...(usage ? { usage } : {}),
              };
              return;
            }
            break;
          }
          case 'message_stop': {
            // message_delta usually carries stop_reason; fall back here.
            const usage = buildUsage();
            yield { type: 'done', stopReason: 'stop', ...(usage ? { usage } : {}) };
            return;
          }
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

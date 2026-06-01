import {
  type Message as BedrockMessage,
  BedrockRuntimeClient,
  type Tool as BedrockTool,
  type ContentBlock,
  ConverseStreamCommand,
  type ConverseStreamCommandInput,
  type ToolUseBlock,
} from '@aws-sdk/client-bedrock-runtime';
import type {
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

export interface BedrockProviderOptions {
  region?: string;
  log: Logger;
  /**
   * Fallback model ids (provider-prefixed, e.g. `amazon-bedrock/global.anthropic.claude-sonnet-4-6`).
   * When stream throws (timeout, throttle), we retry on the next model.
   */
  fallbacks?: readonly string[];
  /** Per-attempt timeout. Default 180s. */
  timeoutMs?: number;
  /** Optional metrics registry. When provided, attempt/retry/fallback events are counted. */
  metrics?: MetricsRegistry;
}

/**
 * Turn the public model id (with or without `amazon-bedrock/` prefix) into
 * the raw Bedrock model id that the SDK expects.
 */
function stripProviderPrefix(id: string): string {
  const idx = id.indexOf('/');
  if (idx < 0) return id;
  return id.slice(idx + 1);
}

function convertMessages(msgs: readonly Message[]): BedrockMessage[] {
  // Bedrock expects role in { 'user' | 'assistant' } only; system goes to `system` field,
  // and `tool` role is modeled as role='user' with toolResult blocks.
  const out: BedrockMessage[] = [];
  for (const m of msgs) {
    if (m.role === 'system') continue; // collapsed into top-level system
    if (m.role === 'tool') {
      out.push({
        role: 'user',
        content: m.content
          .filter((c) => c.type === 'tool_result')
          .map((c) => {
            const tr = c as { toolUseId: string; content: string; isError?: boolean };
            return {
              toolResult: {
                toolUseId: tr.toolUseId,
                content: [{ text: tr.content }],
                ...(tr.isError ? { status: 'error' as const } : {}),
              },
            };
          }),
      });
      continue;
    }
    const role: 'user' | 'assistant' = m.role === 'assistant' ? 'assistant' : 'user';
    const blocks: ContentBlock[] = [];
    for (const c of m.content) {
      if (c.type === 'text') blocks.push({ text: c.text });
      else if (c.type === 'tool_use') {
        blocks.push({
          toolUse: {
            toolUseId: c.id,
            name: c.name,
            input: c.input as ToolUseBlock['input'],
          },
        });
      } else if (c.type === 'image') {
        // Bedrock's ImageFormat is 'jpeg' | 'png' | 'gif' | 'webp' — not the full MIME.
        const format = c.mimeType.split('/')[1] as 'jpeg' | 'png' | 'gif' | 'webp';
        blocks.push({
          image: {
            format,
            source: { bytes: Buffer.from(c.data, 'base64') },
          },
        });
      }
    }
    if (blocks.length > 0) out.push({ role, content: blocks });
  }
  return out;
}

function convertTools(tools: readonly ToolSpec[]): BedrockTool[] | undefined {
  if (tools.length === 0) return undefined;
  return tools.map(
    (t) =>
      ({
        toolSpec: {
          name: t.name,
          description: t.description,
          inputSchema: { json: t.inputSchema as Record<string, unknown> },
        },
      }) as BedrockTool,
  );
}

export class BedrockProvider implements Provider {
  readonly name = 'bedrock';
  private client: BedrockRuntimeClient;
  private log: Logger;
  private fallbacks: readonly string[];
  private timeoutMs: number;
  private metrics?: MetricsRegistry;

  constructor(opts: BedrockProviderOptions) {
    this.client = new BedrockRuntimeClient({
      region: opts.region ?? process.env.AWS_REGION ?? 'us-west-2',
    });
    this.log = opts.log.child({ provider: 'bedrock' });
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
      this.log.info({ model: modelId }, 'bedrock_attempt');
      if (prevModel) {
        this.metrics?.inc('provider_fallback_total', {
          provider: 'bedrock',
          from_model: prevModel,
          to_model: modelId,
        });
      }
      try {
        yield* this.streamOne(req, modelId, signal);
        this.metrics?.inc('provider_attempt_total', {
          provider: 'bedrock',
          model: modelId,
          outcome: 'success',
        });
        return;
      } catch (e) {
        lastError = e as Error;
        this.log.warn({ model: modelId, error: lastError.message }, 'bedrock_attempt_failed');
        this.metrics?.inc('provider_attempt_total', {
          provider: 'bedrock',
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

    const input: ConverseStreamCommandInput = {
      modelId,
      system: [{ text: req.system }],
      messages: convertMessages(req.messages),
      ...(req.tools.length > 0 ? { toolConfig: { tools: convertTools(req.tools) ?? [] } } : {}),
      inferenceConfig: {
        maxTokens: req.maxTokens ?? 8192,
        ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
      },
      // Extended thinking on Bedrock-Claude is opted in via the
      // additionalModelRequestFields escape hatch — Converse doesn't have a
      // first-class `thinking` field. We use adaptive mode: Opus 4.7+ ONLY
      // supports adaptive (manual `enabled`+`budget_tokens` returns 400);
      // older 4.6 / sonnet models also accept it. The `effort` parameter
      // MUST live in a separate `output_config` object — Bedrock rejects
      // it inside `thinking`. Bedrock surfaces deltas as `reasoningContent`
      // blocks in contentBlockDelta events.
      ...(req.thinking?.enabled
        ? {
            additionalModelRequestFields: {
              thinking: { type: 'adaptive' },
              output_config: { effort: req.thinking.effort ?? 'high' },
            },
          }
        : {}),
    };

    yield { type: 'status', status: { kind: 'attempt_started', detail: modelId } };

    try {
      // Retry only the HTTP send — once we start iterating `resp.stream` any
      // emitted chunks have left this function and a retry would duplicate them.
      const metrics = this.metrics;
      const resp = await withRetry(
        () =>
          this.client.send(new ConverseStreamCommand(input), {
            abortSignal: attemptCtl.signal,
          }),
        {
          signal: attemptCtl.signal,
          log: this.log,
          logCtx: { provider: 'bedrock', model: modelId },
          ...(metrics
            ? {
                onRetry: () =>
                  metrics.inc('provider_retry_total', { provider: 'bedrock', model: modelId }),
              }
            : {}),
        },
      );
      // Stream open, no text yet — surface a "thinking" beat so the host
      // can update its placeholder before the first content_block_delta.
      yield { type: 'status', status: { kind: 'thinking' } };

      // Maintain partial tool_use state across deltas.
      const partialToolUses = new Map<number, { id: string; name: string; jsonAccum: string }>();
      // Bedrock emits usage in the final metadata event AFTER messageStop;
      // capture it here and attach to the `done` chunk when we see it.
      let pendingUsage: StreamChunk['usage'];
      let finalStopReason: StreamChunk['stopReason'] | undefined;
      // Diagnostic counters — emitted once at messageStop so we can see
      // whether Bedrock actually streamed reasoning deltas in this turn.
      let textDeltaCount = 0;
      let reasoningDeltaCount = 0;
      let unknownDeltaCount = 0;
      let unknownDeltaSample: string | undefined;

      for await (const event of resp.stream ?? []) {
        if (event.metadata?.usage) {
          const u = event.metadata.usage as {
            inputTokens?: number;
            outputTokens?: number;
            cacheReadInputTokens?: number;
            cacheWriteInputTokens?: number;
          };
          pendingUsage = {
            inputTokens: u.inputTokens ?? 0,
            outputTokens: u.outputTokens ?? 0,
            ...(u.cacheReadInputTokens !== undefined
              ? { cacheReadTokens: u.cacheReadInputTokens }
              : {}),
            ...(u.cacheWriteInputTokens !== undefined
              ? { cacheCreationTokens: u.cacheWriteInputTokens }
              : {}),
          };
          continue;
        }
        if (event.contentBlockStart?.start?.toolUse) {
          const tu = event.contentBlockStart.start.toolUse;
          partialToolUses.set(event.contentBlockStart.contentBlockIndex ?? 0, {
            id: tu.toolUseId ?? '',
            name: tu.name ?? '',
            jsonAccum: '',
          });
        } else if (event.contentBlockDelta?.delta?.text) {
          textDeltaCount += 1;
          yield { type: 'text_delta', text: event.contentBlockDelta.delta.text };
        } else if (event.contentBlockDelta?.delta?.toolUse?.input !== undefined) {
          const idx = event.contentBlockDelta.contentBlockIndex ?? 0;
          const cur = partialToolUses.get(idx);
          if (cur) cur.jsonAccum += event.contentBlockDelta.delta.toolUse.input;
        } else if (event.contentBlockDelta?.delta?.reasoningContent) {
          // Bedrock surfaces extended thinking as reasoningContent deltas.
          // Three member types: TextMember (incremental thinking text),
          // SignatureMember (sealing token, scope (c) ignores), and
          // RedactedContentMember (encrypted thinking, also ignored). We
          // only forward visible text.
          const rc = event.contentBlockDelta.delta.reasoningContent as {
            text?: string;
            signature?: string;
            redactedContent?: Uint8Array;
          };
          if (typeof rc.text === 'string' && rc.text.length > 0) {
            reasoningDeltaCount += 1;
            yield { type: 'thinking_delta', thinking: rc.text };
          }
        } else if (event.contentBlockDelta) {
          // Catch-all: a delta whose member type we don't yet handle. Sample
          // the first one's keys for diagnostic logging at messageStop.
          unknownDeltaCount += 1;
          if (!unknownDeltaSample) {
            unknownDeltaSample = JSON.stringify(event.contentBlockDelta).slice(0, 300);
          }
        } else if (event.contentBlockStop) {
          const idx = event.contentBlockStop.contentBlockIndex ?? 0;
          const cur = partialToolUses.get(idx);
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
            partialToolUses.delete(idx);
          }
        } else if (event.messageStop?.stopReason) {
          const raw = event.messageStop.stopReason;
          finalStopReason =
            raw === 'tool_use'
              ? 'tool_use'
              : raw === 'max_tokens'
                ? 'max_tokens'
                : raw === 'end_turn' || raw === 'stop_sequence'
                  ? 'stop'
                  : 'error';
          // Don't return here — metadata (usage) may arrive after messageStop.
          // Keep iterating until the stream naturally ends.
        }
      }
      // Diagnostic — log delta-type counts once per attempt so operators can
      // see whether Bedrock is actually streaming reasoningContent in this
      // model's adaptive-thinking mode.
      this.log.info(
        {
          model: modelId,
          textDeltas: textDeltaCount,
          reasoningDeltas: reasoningDeltaCount,
          unknownDeltas: unknownDeltaCount,
          ...(unknownDeltaSample ? { unknownSample: unknownDeltaSample } : {}),
        },
        'bedrock_delta_counts',
      );
      yield {
        type: 'done',
        stopReason: finalStopReason ?? 'stop',
        ...(pendingUsage ? { usage: pendingUsage } : {}),
      };
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
    }
  }
}

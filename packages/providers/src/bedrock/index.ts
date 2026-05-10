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
  Provider,
  StreamChunk,
  ToolSpec,
  ToolUsePart,
  TurnRequest,
} from '@postline/core';

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

  constructor(opts: BedrockProviderOptions) {
    this.client = new BedrockRuntimeClient({
      region: opts.region ?? process.env.AWS_REGION ?? 'us-west-2',
    });
    this.log = opts.log.child({ provider: 'bedrock' });
    this.fallbacks = opts.fallbacks ?? [];
    this.timeoutMs = opts.timeoutMs ?? 180_000;
  }

  async *stream(req: TurnRequest, signal: AbortSignal): AsyncIterable<StreamChunk> {
    const chain = [req.model, ...this.fallbacks];
    let lastError: Error | null = null;
    for (const fullId of chain) {
      const modelId = stripProviderPrefix(fullId);
      this.log.info({ model: modelId }, 'bedrock_attempt');
      try {
        yield* this.streamOne(req, modelId, signal);
        return;
      } catch (e) {
        lastError = e as Error;
        this.log.warn({ model: modelId, error: lastError.message }, 'bedrock_attempt_failed');
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

    const input: ConverseStreamCommandInput = {
      modelId,
      system: [{ text: req.system }],
      messages: convertMessages(req.messages),
      ...(req.tools.length > 0 ? { toolConfig: { tools: convertTools(req.tools) ?? [] } } : {}),
      inferenceConfig: {
        maxTokens: req.maxTokens ?? 8192,
        ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
      },
    };

    try {
      const resp = await this.client.send(new ConverseStreamCommand(input), {
        abortSignal: attemptCtl.signal,
      });

      // Maintain partial tool_use state across deltas.
      const partialToolUses = new Map<number, { id: string; name: string; jsonAccum: string }>();

      for await (const event of resp.stream ?? []) {
        if (event.contentBlockStart?.start?.toolUse) {
          const tu = event.contentBlockStart.start.toolUse;
          partialToolUses.set(event.contentBlockStart.contentBlockIndex ?? 0, {
            id: tu.toolUseId ?? '',
            name: tu.name ?? '',
            jsonAccum: '',
          });
        } else if (event.contentBlockDelta?.delta?.text) {
          yield { type: 'text_delta', text: event.contentBlockDelta.delta.text };
        } else if (event.contentBlockDelta?.delta?.toolUse?.input !== undefined) {
          const idx = event.contentBlockDelta.contentBlockIndex ?? 0;
          const cur = partialToolUses.get(idx);
          if (cur) cur.jsonAccum += event.contentBlockDelta.delta.toolUse.input;
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
          const stop: StreamChunk['stopReason'] =
            raw === 'tool_use'
              ? 'tool_use'
              : raw === 'max_tokens'
                ? 'max_tokens'
                : raw === 'end_turn' || raw === 'stop_sequence'
                  ? 'stop'
                  : 'error';
          yield { type: 'done', stopReason: stop };
          return;
        }
      }
      yield { type: 'done', stopReason: 'stop' };
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
    }
  }
}

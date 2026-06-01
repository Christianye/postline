/**
 * Core types shared across all packages.
 * Keep this file provider/channel-agnostic.
 */

export type Role = 'system' | 'user' | 'assistant' | 'tool';

export interface TextPart {
  type: 'text';
  text: string;
}

export interface ToolUsePart {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ToolResultPart {
  type: 'tool_result';
  toolUseId: string;
  content: string;
  isError?: boolean;
}

export interface ImagePart {
  type: 'image';
  /** base64-encoded bytes, no `data:` prefix. */
  data: string;
  /** Standard MIME type, e.g. 'image/jpeg'. Only jpeg/png/gif/webp are supported by Bedrock Claude. */
  mimeType: 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';
}

export type ContentPart = TextPart | ToolUsePart | ToolResultPart | ImagePart;

export interface Message {
  role: Role;
  content: ContentPart[];
}

export interface ToolSpec {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface TurnRequest {
  system: string;
  messages: Message[];
  tools: ToolSpec[];
  model: string;
  maxTokens?: number;
  temperature?: number;
  stopSequences?: readonly string[];
  /**
   * Extended-thinking (reasoning) request. When set, the provider opts in.
   * The host streams thinking deltas to its UI hook but does not persist
   * them — each turn's reasoning is independent.
   */
  thinking?: {
    enabled: boolean;
    budgetTokens?: number;
  };
}

/**
 * Heartbeat-style updates surfaced from providers and the turn runner so
 * adapters can show "still alive" state to the user during silent windows
 * (initial model connect, between iterations, while a tool is executing).
 * Not a model-level signal — the host emits these synthetically.
 */
export interface StreamStatus {
  /**
   * - `attempt_started`: provider opened a stream to the model. `detail` is the model id.
   * - `thinking`: stream is open, no text delta yet (i.e. model is still thinking).
   * - `tool_running`: turn loop is about to invoke a tool. `detail` is the tool name.
   */
  kind: 'attempt_started' | 'thinking' | 'tool_running';
  detail?: string;
}

export interface StreamChunk {
  type:
    | 'text_delta'
    | 'thinking_delta'
    | 'tool_use_start'
    | 'tool_use_delta'
    | 'tool_use_end'
    | 'status'
    | 'done'
    | 'error';
  text?: string;
  /**
   * Set on `thinking_delta` chunks. Carries an incremental piece of the
   * model's extended-thinking output. Not the same as `text` — the host
   * never feeds this back as assistant content; it's UI-only and is not
   * persisted to history.
   */
  thinking?: string;
  toolUse?: ToolUsePart;
  status?: StreamStatus;
  error?: string;
  stopReason?: 'stop' | 'tool_use' | 'max_tokens' | 'error';
  /** Token usage, only present on `done` chunks when the provider reports it. */
  usage?: TokenUsage;
}

export interface TokenUsage {
  /** Fresh input tokens billed at full rate. */
  inputTokens: number;
  /** Output (response) tokens. */
  outputTokens: number;
  /** Tokens served from prompt cache (billed at a discount). */
  cacheReadTokens?: number;
  /** Tokens that went INTO the cache this turn (billed at a premium). */
  cacheCreationTokens?: number;
}

/**
 * Host-side sink for per-turn usage. Run-time wiring (CLI) plugs in an
 * implementation that writes to a JSONL file; tests can plug a no-op or an
 * in-memory collector. Called once per LLM call (multiple per turn when the
 * model calls tools in a loop).
 */
export interface UsageRecorder {
  record(entry: UsageEntry): void | Promise<void>;
}

export interface UsageEntry {
  /** ISO-8601 timestamp. */
  at: string;
  /** Turn id from InboundMessage. */
  turnId: string;
  /** Conversation id (channel-scoped). */
  conversationId: string;
  /** Model id actually called. */
  model: string;
  /** Iteration index within the turn (0 for first LLM call, 1 for follow-up after tool, …). */
  iter: number;
  /** Token counts reported by the provider. */
  usage: TokenUsage;
}

export type ToolRisk = 'read' | 'write' | 'dangerous';

export interface ToolContext {
  /** open_id of the originator (for allowlist enforcement inside tools) */
  userId: string;
  /** channel-specific conversation id (thread / chat_id) */
  conversationId: string;
  /** logger scoped to this turn */
  log: Logger;
  /** signal that caller aborted */
  signal: AbortSignal;
}

export interface Tool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  risk: ToolRisk;
  run(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>;
}

export interface ToolResult {
  content: string;
  isError?: boolean;
  /** Optional structured metadata to attach to logs (NOT returned to the model) */
  meta?: Record<string, unknown>;
}

export interface Provider {
  name: string;
  stream(req: TurnRequest, signal: AbortSignal): AsyncIterable<StreamChunk>;
}

export interface InboundMessage {
  /** globally-unique id for idempotency */
  id: string;
  /** originator open_id / username */
  userId: string;
  /** thread / chat_id */
  conversationId: string;
  /** plain text — channel adapter is responsible for normalizing */
  text: string;
  /** when the message was received */
  receivedAt: number;
  /** channel-specific extras (unstructured) */
  meta?: Record<string, unknown>;
}

export interface OutboundMessage {
  conversationId: string;
  text: string;
  /** channel-specific extras (e.g. feishu reply_in_thread_id) */
  meta?: Record<string, unknown>;
}

export interface Channel {
  name: string;
  /** Start receiving messages; returns a stop function. */
  listen(onMessage: (msg: InboundMessage) => void | Promise<void>): () => Promise<void>;
  send(msg: OutboundMessage): Promise<void>;
  /** Whether this channel is healthy enough to use. */
  health(): Promise<{ ok: boolean; detail?: string }>;
}

export interface Memory {
  /** Load the MEMORY.md + any index content to inject as system prefix. */
  load(): Promise<string>;
  /** Write a memory file; persist (e.g. git push). */
  write(name: string, content: string): Promise<void>;
  /** Read a specific memory file (lazy load detail). */
  read(name: string): Promise<string | null>;
}

export interface HistoryStore {
  load(conversationId: string, limit: number): Promise<Message[]>;
  append(conversationId: string, messages: Message[]): Promise<void>;
}

// Simple logger interface — pino-compatible subset.
export interface Logger {
  info(obj: object | string, msg?: string): void;
  warn(obj: object | string, msg?: string): void;
  error(obj: object | string, msg?: string): void;
  debug(obj: object | string, msg?: string): void;
  child(bindings: Record<string, unknown>): Logger;
}

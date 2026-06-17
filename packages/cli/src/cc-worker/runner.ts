import { type ChildProcess, spawn } from 'node:child_process';
import { type Logger, redact } from '@postline/core';
import { type ProgressEvent, sign } from '@postline/doorbell';

/**
 * cc-worker runner.
 *
 * Lifecycle:
 *  1. POST /mac/register with {host, cwd, pid}.
 *  2. Long-poll loop: GET /mac/poll → 200 task | 204 idle | 401/409.
 *  3. On 200: spawn `claude -p <prompt>` with the headless preamble
 *     (per design §PR-DB-3 Headless invariants), pipe stdout debounced
 *     to /mac/progress, on exit POST /mac/result with status: ok |
 *     failed | timeout | killed.
 *  4. On 401/409: re-register (after backoff).
 *  5. On network/5xx: exponential backoff 1s → 2 → 5 → 10 → 30 cap.
 *
 * The runner is **not** a daemon by itself — it runs in the foreground
 * of `postline cc-worker start`, which is what the operator invokes
 * from a terminal where Claude Code is already open. Closing the
 * terminal (or Ctrl-C) is the natural stop signal; we also handle
 * SIGTERM for `cc-worker stop`.
 *
 * Network IO + child-process spawning are passed in via deps so the
 * unit tests can pin the runner against in-memory fakes. Production
 * builds default to real `fetch` and real `spawn`.
 */

export interface RunnerDeps {
  /** HTTP client. Defaults to global fetch in production. */
  fetch?: typeof globalThis.fetch;
  /** Spawner for headless Claude Code. Defaults to node's child_process.spawn. */
  spawnChild?: typeof spawn;
  /** Clock; tests pass a deterministic source. */
  now?: () => number;
  /** Sleeper; tests pass a vi-controlled timer. */
  sleep?: (ms: number) => Promise<void>;
}

export interface RunnerOptions {
  /** Base URL of the doorbell server, e.g. `http://localhost:9999`. */
  doorbellUrl: string;
  /** 32+ char shared secret. */
  secret: string;
  /** Canonical cwd of this worker. */
  cwd: string;
  /** Reporting hostname. */
  host: string;
  /** Agent kind backing this worker. Default `'cc'` (Claude Code). */
  agentKind?: string;
  /** Process id of the runner. */
  pid: number;
  /** Path to the claude binary. Default `'claude'` (PATH-resolved). */
  claudeBin?: string;
  /** Path to the codex binary. Default `'codex'` (PATH-resolved). */
  codexBin?: string;
  /** Codex sandbox policy (`-s`). Default `'workspace-write'`. */
  codexSandbox?: string;
  /**
   * Codex reasoning effort (`-c model_reasoning_effort`). Default `'low'`
   * for headless worker runs — the operator's global config is often tuned
   * high for interactive use, which makes codex over-think short tasks.
   */
  codexReasoningEffort?: string;
  /** Long-poll timeout in ms. Default 30_000 (matches server default). */
  longPollTimeoutMs?: number;
  /** Per-task headless deadline in ms. Default 5min. */
  taskDeadlineMs?: number;
  /** Progress POST debounce in ms. Default 5_000. */
  progressDebounceMs?: number;
  /**
   * Whether to surface a `💭 thinking` progress event. Default false:
   * thinking can be long / sensitive, so we emit a single elided line
   * only when explicitly enabled (config `progress.showThinking`).
   */
  showThinking?: boolean;
  /**
   * Headless preamble injected before the user's prompt. Default
   * encodes the §PR-DB-3 Headless invariants.
   */
  headlessPreamble?: string;
  log: Logger;
  deps?: RunnerDeps;
}

export interface RegisterResult {
  workerId: string;
  state: 'active' | 'standby';
}

/** POST /mac/register. Returns the assigned workerId or throws on failure. */
export async function registerWorker(opts: RunnerOptions): Promise<RegisterResult> {
  const fetcher = opts.deps?.fetch ?? globalThis.fetch;
  const body = JSON.stringify({
    cwd: opts.cwd,
    hostname: opts.host,
    agentKind: opts.agentKind ?? 'cc',
    pid: opts.pid,
    registeredAt: opts.deps?.now ? opts.deps.now() : Date.now(),
  });
  const path = '/mac/register';
  const ts = opts.deps?.now ? opts.deps.now() : Date.now();
  const sig = sign({ method: 'POST', path, body, ts, secret: opts.secret });
  const res = await fetcher(`${opts.doorbellUrl}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-doorbell-ts': String(ts),
      'x-doorbell-signature': sig,
    },
    body,
  });
  if (res.status !== 200) {
    const text = await res.text().catch(() => '');
    throw new Error(`register failed: ${res.status} ${text.slice(0, 200)}`);
  }
  const json = (await res.json()) as RegisterResult;
  return json;
}

export interface PollResult {
  /** 200 + task body. */
  task?: {
    taskId: string;
    prompt: string;
    cwd: string;
    deadlineMs: number;
    retryCount: number;
  };
  /** 204 / non-200 outcome. */
  status: 'task' | 'idle' | 'unknown_worker' | 'demoted' | 'standby' | 'error';
  errorBody?: unknown;
}

/** GET /mac/poll. Holds for up to longPollTimeoutMs server-side. */
export async function pollOnce(opts: RunnerOptions, workerId: string): Promise<PollResult> {
  const fetcher = opts.deps?.fetch ?? globalThis.fetch;
  const path = `/mac/poll?workerId=${encodeURIComponent(workerId)}`;
  const ts = opts.deps?.now ? opts.deps.now() : Date.now();
  const sig = sign({ method: 'GET', path, body: '', ts, secret: opts.secret });
  const res = await fetcher(`${opts.doorbellUrl}${path}`, {
    method: 'GET',
    headers: {
      'x-doorbell-ts': String(ts),
      'x-doorbell-signature': sig,
    },
  });
  if (res.status === 200) {
    const task = (await res.json()) as PollResult['task'];
    return { status: 'task', ...(task ? { task } : {}) };
  }
  if (res.status === 204) return { status: 'idle' };
  if (res.status === 401) return { status: 'unknown_worker' };
  if (res.status === 409) {
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      // ignore
    }
    if (body && typeof body === 'object' && 'status' in body && body.status === 'demoted') {
      return { status: 'demoted', errorBody: body };
    }
    return { status: 'standby', errorBody: body };
  }
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    // ignore
  }
  return { status: 'error', errorBody: body };
}

export interface ProgressBody {
  taskId: string;
  workerId: string;
  summary?: string;
  etaSeconds?: number;
  event?: ProgressEvent;
}

export async function postProgress(opts: RunnerOptions, body: ProgressBody): Promise<void> {
  await postSigned(opts, '/mac/progress', body);
}

export interface ResultBody {
  taskId: string;
  workerId: string;
  status: 'ok' | 'failed' | 'killed' | 'timeout';
  text?: string;
  errorMessage?: string;
}

export async function postResult(opts: RunnerOptions, body: ResultBody): Promise<void> {
  await postSigned(opts, '/mac/result', body);
}

/**
 * Redact secrets from every free-text field before it leaves the worker.
 * The worker runs `claude -p` / `codex exec` with full host env + repo
 * access, so a tool result or final answer can echo an API key / token.
 * This is the worker-side trust boundary; the bridge redacts again on its
 * side (defense in depth) since a worker could be older/un-patched.
 */
function redactBody(body: ProgressBody | ResultBody): ProgressBody | ResultBody {
  const b: ProgressBody | ResultBody = { ...body };
  if ('summary' in b && b.summary) b.summary = redact(b.summary);
  if ('text' in b && b.text) b.text = redact(b.text);
  if ('errorMessage' in b && b.errorMessage) b.errorMessage = redact(b.errorMessage);
  if ('event' in b && b.event?.label) {
    b.event = { ...b.event, label: redact(b.event.label) };
  }
  return b;
}

async function postSigned(
  opts: RunnerOptions,
  path: string,
  body: ProgressBody | ResultBody,
): Promise<void> {
  const fetcher = opts.deps?.fetch ?? globalThis.fetch;
  const bodyText = JSON.stringify(redactBody(body));
  const ts = opts.deps?.now ? opts.deps.now() : Date.now();
  const sig = sign({ method: 'POST', path, body: bodyText, ts, secret: opts.secret });
  const res = await fetcher(`${opts.doorbellUrl}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-doorbell-ts': String(ts),
      'x-doorbell-signature': sig,
    },
    body: bodyText,
  });
  if (res.status !== 200) {
    const text = await res.text().catch(() => '');
    opts.log.warn(
      { path, status: res.status, snippet: text.slice(0, 200) },
      'cc_worker_post_failed',
    );
  }
}

/** Parse an `<eta>SECS</eta>` tag (Claude emits it; codex doesn't). */
function tryEtaParse(text: string): number | null {
  const m = /(?:^|\n)\s*<eta>(\d+)<\/eta>\s*(?:\n|$)/.exec(text);
  if (!m || !m[1]) return null;
  const secs = Number.parseInt(m[1], 10);
  if (!Number.isFinite(secs) || secs <= 0 || secs > 3600) return null;
  return secs;
}

/**
 * Sink the parser pushes into. `setResult` records the authoritative final
 * answer; `emit` surfaces a progress event (eager = flush past debounce,
 * used on tool boundaries).
 */
interface AgentSink {
  setResult: (text: string) => void;
  emit: (event: ProgressEvent, summary: string, eager?: boolean) => void;
}

/**
 * Per-agent headless spec: how to spawn it + how to turn one stdout line
 * into progress/result. Both agents stream newline-delimited JSON; only
 * the binary, args, and event vocabulary differ. The shared `runTask`
 * scaffold (spawn, debounce, deadline, result assembly, POST) is identical.
 */
interface AgentSpec {
  bin: string;
  args: (composedPrompt: string) => string[];
  ingestLine: (line: string, sink: AgentSink) => void;
}

/**
 * Minimal shape of the Claude Code `--output-format stream-json` events.
 * Parsed defensively; unrecognised types/fields ignored.
 */
interface StreamJsonContentBlock {
  type: string;
  name?: string; // tool_use
  input?: Record<string, unknown>; // tool_use
  text?: string; // text
}
interface StreamJsonEvent {
  type: string;
  subtype?: string;
  result?: string;
  message?: { content?: StreamJsonContentBlock[] };
}

/** Claude Code agent spec — `claude -p … --output-format stream-json`. */
function claudeSpec(opts: RunnerOptions): AgentSpec {
  const bin = opts.claudeBin ?? 'claude';
  return {
    bin,
    args: (prompt) => ['-p', prompt, '--output-format', 'stream-json', '--verbose'],
    ingestLine: (line, sink) => {
      let ev: StreamJsonEvent | null = null;
      try {
        const o = JSON.parse(line);
        ev =
          o && typeof o === 'object' && typeof o.type === 'string' ? (o as StreamJsonEvent) : null;
      } catch {
        return;
      }
      if (!ev) return;
      if (ev.type === 'assistant' && ev.message?.content) {
        for (const block of ev.message.content) {
          if (block.type === 'tool_use') {
            sink.emit({ kind: 'tool', label: formatToolLabel(block.name, block.input) }, '', true);
          } else if (block.type === 'thinking') {
            if (opts.showThinking) sink.emit({ kind: 'thinking', label: '…' }, '💭 …');
          } else if (block.type === 'text' && typeof block.text === 'string') {
            const clipped = block.text.trim().slice(0, 600);
            if (clipped) sink.emit({ kind: 'text', label: clipped }, clipped);
          }
        }
      } else if (ev.type === 'system' && ev.subtype === 'init') {
        sink.emit({ kind: 'init', label: 'worker started' }, '');
      } else if (ev.type === 'result' && typeof ev.result === 'string') {
        sink.setResult(ev.result);
      }
    },
  };
}

/** Minimal shape of `codex exec --json` JSONL events (codex-cli ≥0.139). */
interface CodexEvent {
  type: string; // thread.started | turn.started | item.started | item.completed | turn.completed
  item?: { type?: string; text?: string; command?: string };
}

/**
 * Codex agent spec — `codex exec --json`. Events differ from Claude:
 * final text is the LAST `agent_message` (no single result field); tools
 * are unified `command_execution`. Sandbox `workspace-write` (edit the
 * repo, no network/system) per design OQ-C2. No ETA tag (OQ-C3).
 */
function codexSpec(opts: RunnerOptions): AgentSpec {
  const bin = opts.codexBin ?? 'codex';
  return {
    bin,
    args: (prompt) => [
      'exec',
      '--json',
      '--skip-git-repo-check',
      '-s',
      opts.codexSandbox ?? 'workspace-write',
      // Headless dispatched tasks are usually short; the operator's global
      // `model_reasoning_effort` (often `high`/`xhigh` for interactive use)
      // makes codex deep-reason even trivial replies (~30s for "hello").
      // Pin to a lighter effort for worker runs; override via codexReasoningEffort.
      '-c',
      `model_reasoning_effort=${opts.codexReasoningEffort ?? 'low'}`,
      prompt,
    ],
    ingestLine: (line, sink) => {
      let ev: CodexEvent | null = null;
      try {
        const o = JSON.parse(line);
        ev = o && typeof o === 'object' && typeof o.type === 'string' ? (o as CodexEvent) : null;
      } catch {
        return;
      }
      if (!ev) return;
      if (ev.type === 'thread.started') {
        sink.emit({ kind: 'init', label: 'worker started' }, '');
      } else if (ev.item?.type === 'agent_message' && typeof ev.item.text === 'string') {
        const clipped = ev.item.text.trim().slice(0, 600);
        if (clipped) {
          // Each agent_message is progress; the LAST one is the final answer.
          sink.emit({ kind: 'text', label: clipped }, clipped);
          sink.setResult(ev.item.text);
        }
      } else if (ev.item?.type === 'command_execution' && typeof ev.item.command === 'string') {
        const label = ev.item.command.replace(/\s+/g, ' ').trim().slice(0, 120);
        sink.emit({ kind: 'tool', label }, `🔧 ${label}`, true);
      }
    },
  };
}

/**
 * Render a one-line label for a tool_use block, e.g. `Bash: pnpm test`,
 * `Read: matcher.ts`. Best-effort per known tool; falls back to the bare
 * tool name. Clipped short — the server re-clips at the trust boundary.
 */
function formatToolLabel(
  name: string | undefined,
  input: Record<string, unknown> | undefined,
): string {
  const tool = name ?? 'tool';
  const arg = (k: string): string => (typeof input?.[k] === 'string' ? (input[k] as string) : '');
  let detail = '';
  switch (tool) {
    case 'Bash':
      detail = arg('command');
      break;
    case 'Read':
    case 'Edit':
    case 'Write':
      detail = arg('file_path');
      break;
    case 'Grep':
      detail = arg('pattern');
      break;
    case 'Glob':
      detail = arg('pattern');
      break;
    default:
      detail = '';
  }
  const clipped = detail.replace(/\s+/g, ' ').trim().slice(0, 120);
  return clipped ? `${tool}: ${clipped}` : tool;
}

const DEFAULT_PREAMBLE = [
  'You are running headless on behalf of postline-the-bridge.',
  '',
  'Reply in 中文 (Simplified Chinese) by default unless the user writes',
  'in another language or asks otherwise. Your reply is relayed verbatim',
  'into a Feishu message, so keep it self-contained and readable there.',
  '',
  'If you predict total runtime > 30s, emit exactly `<eta>SECS</eta>` on a',
  'line by itself before any tool calls. Otherwise emit nothing for the',
  'ETA tag. Then proceed with the user request below.',
  '',
  '---',
  '',
].join('\n');

export interface RunOnceParams {
  opts: RunnerOptions;
  workerId: string;
  task: NonNullable<PollResult['task']>;
}

/**
 * Run a single dispatched task: spawn `claude -p`, pipe stdout to
 * progress (debounced), POST result on exit. Returns the final result
 * payload so callers can decide whether to keep polling.
 */
export async function runTask(params: RunOnceParams): Promise<ResultBody> {
  const { opts, workerId, task } = params;
  const spawner = opts.deps?.spawnChild ?? spawn;
  const preamble = opts.headlessPreamble ?? DEFAULT_PREAMBLE;
  const composedPrompt = `${preamble}${task.prompt}`;
  const spec = opts.agentKind === 'codex' ? codexSpec(opts) : claudeSpec(opts);

  let stderrBuf = '';
  const debounceMs = opts.progressDebounceMs ?? 5_000;
  let lastProgressPost = 0;
  let killed = false;

  // Parser state shared by all agent specs. `resultText` is the
  // authoritative final answer; `latestEvent`/`latestSummary` feed
  // progress; `lineBuf` holds a partial trailing line across chunks.
  let lineBuf = '';
  const sink: AgentSink = {
    setResult: (text) => {
      resultText = text;
    },
    emit: (event, summary, eager) => {
      latestEvent = event;
      latestSummary = summary;
      void pushProgress(eager === true);
    },
  };
  let resultText = '';
  let latestEvent: ProgressEvent | null = null;
  let latestSummary = '';

  const child: ChildProcess = spawner(spec.bin, spec.args(composedPrompt), {
    stdio: ['ignore', 'pipe', 'pipe'],
    cwd: opts.cwd,
  });

  const pushProgress = async (force = false): Promise<void> => {
    const now = opts.deps?.now ? opts.deps.now() : Date.now();
    if (!force && now - lastProgressPost < debounceMs) return;
    lastProgressPost = now;
    const summary = latestSummary.slice(0, 600);
    const eta = tryEtaParse(latestSummary);
    await postProgress(opts, {
      taskId: task.taskId,
      workerId,
      ...(summary ? { summary } : {}),
      ...(eta !== null ? { etaSeconds: eta } : {}),
      ...(latestEvent ? { event: latestEvent } : {}),
    });
  };

  child.stdout?.on('data', (chunk: Buffer) => {
    lineBuf += chunk.toString('utf8');
    let nl = lineBuf.indexOf('\n');
    while (nl >= 0) {
      const line = lineBuf.slice(0, nl).trim();
      lineBuf = lineBuf.slice(nl + 1);
      if (line) spec.ingestLine(line, sink);
      nl = lineBuf.indexOf('\n');
    }
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    stderrBuf += chunk.toString('utf8');
  });

  const deadline = task.deadlineMs;
  let timer: NodeJS.Timeout | null = null;
  if (deadline > 0) {
    const ms = Math.max(0, deadline - (opts.deps?.now ? opts.deps.now() : Date.now()));
    timer = setTimeout(() => {
      killed = true;
      try {
        child.kill('SIGTERM');
      } catch {
        // ignore
      }
    }, ms);
    if (typeof timer.unref === 'function') timer.unref();
  }

  let spawnError: string | null = null;
  const exitCode: number | null = await new Promise((resolve) => {
    child.on('exit', (code) => resolve(code));
    child.on('error', (err: Error) => {
      // Spawn failure (ENOENT when `claude` is off PATH, EACCES, etc.).
      // Surface it: without this the task silently stalls at 🟡 with no
      // log line to debug against.
      spawnError = err.message;
      opts.log.error(
        { err: err.message, bin: spec.bin, taskId: task.taskId },
        'cc_worker_spawn_error',
      );
      resolve(null);
    });
  });
  if (timer) clearTimeout(timer);

  // Flush any trailing partial line — the final event often arrives
  // without a trailing newline, so it would otherwise sit unparsed in
  // lineBuf and the result text would be lost.
  if (lineBuf.trim()) {
    spec.ingestLine(lineBuf.trim(), sink);
    lineBuf = '';
  }

  // Flush a final progress post (force) before sending the result so
  // the IM UX doesn't lose the tail of the output.
  try {
    await pushProgress(true);
  } catch {
    // ignore
  }

  // Prefer the authoritative `result` event text; fall back to the last
  // streamed assistant text if the process died before emitting `result`.
  const finalText = resultText || latestSummary;
  let resultBody: ResultBody;
  if (killed) {
    resultBody = {
      taskId: task.taskId,
      workerId,
      status: 'timeout',
      text: finalText,
      errorMessage: 'task exceeded deadline',
    };
  } else if (exitCode === 0) {
    resultBody = { taskId: task.taskId, workerId, status: 'ok', text: finalText };
  } else if (exitCode === null) {
    resultBody = {
      taskId: task.taskId,
      workerId,
      status: 'killed',
      text: finalText,
      errorMessage: spawnError ? `spawn failed: ${spawnError}` : 'spawn failed',
    };
  } else {
    resultBody = {
      taskId: task.taskId,
      workerId,
      status: 'failed',
      text: finalText,
      errorMessage: `exit ${exitCode}: ${stderrBuf.slice(-500)}`,
    };
  }
  try {
    await postResult(opts, resultBody);
  } catch (err) {
    opts.log.warn({ err: (err as Error).message }, 'cc_worker_result_post_error');
  }
  return resultBody;
}

/**
 * Sleep with exponential backoff capped at 30s.
 *
 * Sequence: 1s → 2 → 5 → 10 → 30 → 30 → ...
 */
export function backoffMs(attempt: number): number {
  const ladder = [1_000, 2_000, 5_000, 10_000, 30_000];
  if (attempt < 0) return 0;
  if (attempt >= ladder.length) return 30_000;
  return ladder[attempt] ?? 30_000;
}

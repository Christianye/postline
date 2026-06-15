import { EventEmitter } from 'node:events';
import type { Logger } from '@postline/core';
import { DoorbellCoordinator, startDoorbellServer } from '@postline/doorbell';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type RunnerOptions, backoffMs, pollOnce, registerWorker, runTask } from './runner.js';

const SECRET = 'POSTLINE_DOORBELL_TEST_SECRET_32_BYTES_OPAQUE';

function silentLogger(): Logger {
  const noop = () => {};
  // biome-ignore lint/suspicious/noExplicitAny: minimal logger stub for tests
  const log: any = {
    info: noop,
    warn: noop,
    error: noop,
    debug: noop,
    trace: noop,
    fatal: noop,
  };
  log.child = () => log;
  return log as Logger;
}

describe('cc-worker runner — integration against a real doorbell server', () => {
  let coord: DoorbellCoordinator;
  let serverUrl: string;
  let close: () => Promise<void>;

  beforeEach(async () => {
    coord = new DoorbellCoordinator({ log: silentLogger() });
    const handle = await startDoorbellServer({
      coordinator: coord,
      secret: SECRET,
      host: '127.0.0.1',
      port: 0,
      longPollTimeoutMs: 200,
      log: silentLogger(),
    });
    serverUrl = `http://${handle.address.host}:${handle.address.port}`;
    close = () => handle.close();
  });

  afterEach(async () => {
    await close();
    coord.stop();
  });

  function opts(over: Partial<RunnerOptions> = {}): RunnerOptions {
    return {
      doorbellUrl: serverUrl,
      secret: SECRET,
      cwd: '/test/cwd',
      host: 'test-host',
      pid: 1234,
      log: silentLogger(),
      ...over,
    };
  }

  it('register → poll(idle) round-trip via real signed HTTP', async () => {
    const reg = await registerWorker(opts());
    expect(reg.workerId).toMatch(/^w_[0-9a-f]{8}$/);
    expect(reg.state).toBe('active');

    const poll = await pollOnce(opts(), reg.workerId);
    expect(poll.status).toBe('idle');
  });

  it('register → enqueue → poll(task) returns the task body', async () => {
    const reg = await registerWorker(opts());
    coord.queue.enqueue({ cwd: '/test/cwd', prompt: 'do this thing' });

    const poll = await pollOnce(opts(), reg.workerId);
    expect(poll.status).toBe('task');
    expect(poll.task?.prompt).toBe('do this thing');
    expect(poll.task?.cwd).toBe('/test/cwd');
  });

  it('poll on a worker that has been demoted returns demoted', async () => {
    const r1 = await registerWorker(opts());
    // Second register from a different pid demotes the first.
    await registerWorker(opts({ pid: 5678 }));
    const poll = await pollOnce(opts(), r1.workerId);
    // The fresh poll on a non-active worker returns 409 status:standby
    // synchronously (server.ts handlePoll early return), so we observe
    // that here. The 'demoted' status is for in-flight long-polls
    // (covered in doorbell longpoll.test.ts).
    expect(poll.status).toBe('standby');
  });

  it('poll on an unknown worker returns unknown_worker', async () => {
    const poll = await pollOnce(opts(), 'w_nonexistent');
    expect(poll.status).toBe('unknown_worker');
  });

  it('register on a wrong secret raises an explicit error', async () => {
    await expect(registerWorker(opts({ secret: 'wrong' }))).rejects.toThrow(/register failed/);
  });

  it('spawn failure is surfaced (logged + reported as killed), not swallowed', async () => {
    const reg = await registerWorker(opts());
    coord.queue.enqueue({ cwd: '/test/cwd', prompt: 'do this thing' });
    const poll = await pollOnce(opts(), reg.workerId);
    expect(poll.status).toBe('task');

    // Fake child that emits 'error' on next tick (ENOENT-style spawn fail).
    const fakeSpawn = (() => {
      const ee = new EventEmitter() as EventEmitter & {
        stdout: null;
        stderr: null;
        kill: () => void;
      };
      ee.stdout = null;
      ee.stderr = null;
      ee.kill = () => {};
      queueMicrotask(() => ee.emit('error', new Error('spawn claude ENOENT')));
      return ee;
      // biome-ignore lint/suspicious/noExplicitAny: minimal child stub
    }) as any;

    const errors: unknown[] = [];
    const log = silentLogger();
    (log as { error: (...a: unknown[]) => void }).error = (...a) => errors.push(a);

    const result = await runTask({
      opts: opts({ log, deps: { spawnChild: fakeSpawn } }),
      workerId: reg.workerId,
      task: poll.task!,
    });

    expect(result.status).toBe('killed');
    expect(result.errorMessage).toContain('ENOENT');
    // Must have logged the spawn error rather than swallowing it.
    expect(errors.length).toBeGreaterThan(0);
  });

  it('parses stream-json: result text from `result` event, tool event posted', async () => {
    const reg = await registerWorker(opts());
    coord.queue.enqueue({ cwd: '/test/cwd', prompt: 'review the diff' });
    const poll = await pollOnce(opts(), reg.workerId);
    expect(poll.status).toBe('task');

    // Capture progress events the coordinator emits to the bridge hook.
    const progressEvents: Array<{ kind?: string; label?: string }> = [];
    coord.notifyProgress = ((p: { event?: { kind: string; label: string } }) => {
      if (p.event) progressEvents.push(p.event);
      // biome-ignore lint/suspicious/noExplicitAny: test spy override
    }) as any;

    // Fake child that streams newline-delimited JSON events, then exits 0.
    const lines = [
      JSON.stringify({ type: 'system', subtype: 'init', session_id: 's1' }),
      JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'git show' } }] },
      }),
      JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'The diff looks fine.' }] },
      }),
      JSON.stringify({ type: 'result', subtype: 'success', result: 'Final review: LGTM.' }),
    ];
    let capturedArgs: string[] = [];
    const fakeSpawn = ((_bin: string, args: string[]) => {
      capturedArgs = args;
      const ee = new EventEmitter() as EventEmitter & {
        stdout: EventEmitter;
        stderr: EventEmitter;
        kill: () => void;
      };
      ee.stdout = new EventEmitter();
      ee.stderr = new EventEmitter();
      ee.kill = () => {};
      queueMicrotask(() => {
        // Emit events split across chunk boundaries to exercise the line buffer.
        ee.stdout.emit('data', Buffer.from(`${lines[0]}\n${lines[1]}\n`));
        ee.stdout.emit('data', Buffer.from(`${lines[2]}\n`));
        ee.stdout.emit('data', Buffer.from(`${lines[3]}`)); // no trailing newline
        ee.emit('exit', 0);
      });
      return ee;
      // biome-ignore lint/suspicious/noExplicitAny: minimal child stub
    }) as any;

    const result = await runTask({
      opts: opts({ deps: { spawnChild: fakeSpawn } }),
      workerId: reg.workerId,
      task: poll.task!,
    });

    expect(result.status).toBe('ok');
    // Result text comes from the `result` event, not raw stdout.
    expect(result.text).toBe('Final review: LGTM.');
    // The spawn used stream-json output format.
    expect(capturedArgs).toContain('--output-format');
    expect(capturedArgs).toContain('stream-json');
    // A tool progress event was surfaced with a formatted label.
    const tool = progressEvents.find((e) => e.kind === 'tool');
    expect(tool?.label).toBe('Bash: git show');
  });

  it('parses codex exec --json: final text = last agent_message, command_execution tool', async () => {
    const reg = await registerWorker(opts({ agentKind: 'codex' }));
    coord.queue.enqueue({ cwd: '/test/cwd', prompt: 'fix the lint' });
    const poll = await pollOnce(opts({ agentKind: 'codex' }), reg.workerId);
    expect(poll.status).toBe('task');

    const progressEvents: Array<{ kind?: string; label?: string }> = [];
    coord.notifyProgress = ((p: { event?: { kind: string; label: string } }) => {
      if (p.event) progressEvents.push(p.event);
      // biome-ignore lint/suspicious/noExplicitAny: test spy override
    }) as any;

    // codex-cli JSONL events (codex-cli ≥0.139 shape).
    const lines = [
      JSON.stringify({ type: 'thread.started', thread_id: 't1' }),
      JSON.stringify({ type: 'turn.started' }),
      JSON.stringify({
        type: 'item.started',
        item: { id: 'i1', type: 'command_execution', command: 'pnpm lint --fix' },
      }),
      JSON.stringify({
        type: 'item.completed',
        item: { id: 'i2', type: 'agent_message', text: 'Lint fixed; all green.' },
      }),
      JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 10 } }),
    ];
    let capturedBin = '';
    let capturedArgs: string[] = [];
    const fakeSpawn = ((bin: string, args: string[]) => {
      capturedBin = bin;
      capturedArgs = args;
      const ee = new EventEmitter() as EventEmitter & {
        stdout: EventEmitter;
        stderr: EventEmitter;
        kill: () => void;
      };
      ee.stdout = new EventEmitter();
      ee.stderr = new EventEmitter();
      ee.kill = () => {};
      queueMicrotask(() => {
        ee.stdout.emit('data', Buffer.from(`${lines[0]}\n${lines[1]}\n`));
        ee.stdout.emit('data', Buffer.from(`${lines[2]}\n`));
        ee.stdout.emit('data', Buffer.from(`${lines[3]}\n${lines[4]}`)); // last has no trailing nl
        ee.emit('exit', 0);
      });
      return ee;
      // biome-ignore lint/suspicious/noExplicitAny: minimal child stub
    }) as any;

    const result = await runTask({
      opts: opts({ agentKind: 'codex', deps: { spawnChild: fakeSpawn } }),
      workerId: reg.workerId,
      task: poll.task!,
    });

    expect(result.status).toBe('ok');
    // Final text = the last agent_message (codex has no single result field).
    expect(result.text).toBe('Lint fixed; all green.');
    // Spawned `codex exec --json`.
    expect(capturedBin).toBe('codex');
    expect(capturedArgs).toContain('exec');
    expect(capturedArgs).toContain('--json');
    // command_execution surfaced as a tool progress event.
    const tool = progressEvents.find((e) => e.kind === 'tool');
    expect(tool?.label).toBe('pnpm lint --fix');
  });
});

describe('backoffMs', () => {
  it('follows the documented ladder 1→2→5→10→30, then caps at 30', () => {
    expect(backoffMs(0)).toBe(1_000);
    expect(backoffMs(1)).toBe(2_000);
    expect(backoffMs(2)).toBe(5_000);
    expect(backoffMs(3)).toBe(10_000);
    expect(backoffMs(4)).toBe(30_000);
    expect(backoffMs(5)).toBe(30_000);
    expect(backoffMs(99)).toBe(30_000);
  });

  it('returns 0 for negative attempts (defensive)', () => {
    expect(backoffMs(-1)).toBe(0);
  });
});

import type { Logger } from '@postline/core';
import { DoorbellCoordinator, startDoorbellServer } from '@postline/doorbell';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type RunnerOptions, backoffMs, pollOnce, registerWorker } from './runner.js';

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

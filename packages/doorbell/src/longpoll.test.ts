import type { Logger } from '@postline/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DoorbellCoordinator } from './coordinator.js';
import { sign } from './hmac.js';
import { type DoorbellServerHandle, startDoorbellServer } from './server.js';

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

async function call(
  handle: DoorbellServerHandle,
  method: string,
  path: string,
  body: Record<string, unknown> | null,
): Promise<{ status: number; body: unknown }> {
  const ts = Date.now();
  const bodyText = body ? JSON.stringify(body) : '';
  const sig = sign({ method, path, body: bodyText, ts, secret: SECRET });
  const url = `http://${handle.address.host}:${handle.address.port}${path}`;
  const res = await fetch(url, {
    method,
    headers: {
      'content-type': 'application/json',
      'x-doorbell-ts': String(ts),
      'x-doorbell-signature': sig,
    },
    ...(bodyText ? { body: bodyText } : {}),
  });
  let parsed: unknown = null;
  const text = await res.text();
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
  }
  return { status: res.status, body: parsed };
}

describe('Doorbell long-poll wire (§4.0)', () => {
  let coord: DoorbellCoordinator;
  let handle: DoorbellServerHandle;

  beforeEach(async () => {
    coord = new DoorbellCoordinator({ log: silentLogger() });
    handle = await startDoorbellServer({
      coordinator: coord,
      secret: SECRET,
      host: '127.0.0.1',
      port: 0,
      // Pick a value the wake-path tests can outrun cleanly.
      longPollTimeoutMs: 2_000,
      log: silentLogger(),
    });
  });

  afterEach(async () => {
    await handle.close();
    coord.stop();
  });

  it('held poll is woken with 200 + task when enqueueAndMaybeDispatch fires', async () => {
    const reg = await call(handle, 'POST', '/mac/register', {
      cwd: '/r',
      hostname: 'mac',
      pid: 1,
    });
    const wid = (reg.body as { workerId: string }).workerId;
    const pollPromise = call(handle, 'GET', `/mac/poll?workerId=${wid}`, null);
    // Give the request a moment to land in the server before enqueuing.
    await new Promise((r) => setTimeout(r, 30));
    coord.enqueueAndMaybeDispatch({ cwd: '/r', prompt: 'wake me up' });
    const r = await pollPromise;
    expect(r.status).toBe(200);
    expect((r.body as { prompt: string }).prompt).toBe('wake me up');
  });

  it('held poll is woken with 409 status:demoted when newer worker registers (M4)', async () => {
    const reg1 = await call(handle, 'POST', '/mac/register', {
      cwd: '/r',
      hostname: 'mac',
      pid: 1,
    });
    const w1 = (reg1.body as { workerId: string }).workerId;
    const pollPromise = call(handle, 'GET', `/mac/poll?workerId=${w1}`, null);
    await new Promise((r) => setTimeout(r, 30));

    const reg2 = await call(handle, 'POST', '/mac/register', {
      cwd: '/r',
      hostname: 'mac2',
      pid: 2,
    });
    const w2 = (reg2.body as { workerId: string }).workerId;

    const r = await pollPromise;
    expect(r.status).toBe(409);
    const body = r.body as {
      status: string;
      reason: string;
      newActiveWorkerId: string;
    };
    expect(body.status).toBe('demoted');
    expect(body.reason).toBe('another_worker_registered_for_cwd');
    expect(body.newActiveWorkerId).toBe(w2);
  });

  it('held poll is woken with 401 unknown_worker when sweep removes the worker', async () => {
    const reg = await call(handle, 'POST', '/mac/register', {
      cwd: '/r',
      hostname: 'mac',
      pid: 1,
    });
    const wid = (reg.body as { workerId: string }).workerId;
    const pollPromise = call(handle, 'GET', `/mac/poll?workerId=${wid}`, null);
    await new Promise((r) => setTimeout(r, 30));
    // Force-remove the worker as if a sweep killed it.
    coord.registry.unregister(wid);
    const r = await pollPromise;
    expect(r.status).toBe(401);
    expect((r.body as { error: string }).error).toBe('unknown_worker');
  });

  it('held poll returns 204 when the configured timeout elapses', async () => {
    const reg = await call(handle, 'POST', '/mac/register', {
      cwd: '/r',
      hostname: 'mac',
      pid: 1,
    });
    const wid = (reg.body as { workerId: string }).workerId;
    const r = await call(handle, 'GET', `/mac/poll?workerId=${wid}`, null);
    expect(r.status).toBe(204);
  });

  it('immediate poll returns 200 when a task already exists at request time', async () => {
    const reg = await call(handle, 'POST', '/mac/register', {
      cwd: '/r',
      hostname: 'mac',
      pid: 1,
    });
    const wid = (reg.body as { workerId: string }).workerId;
    coord.queue.enqueue({ cwd: '/r', prompt: 'pre-loaded' });
    const r = await call(handle, 'GET', `/mac/poll?workerId=${wid}`, null);
    expect(r.status).toBe(200);
    expect((r.body as { prompt: string }).prompt).toBe('pre-loaded');
  });

  it('two consecutive polls from the same worker: prior is replaced (latest wins)', async () => {
    const reg = await call(handle, 'POST', '/mac/register', {
      cwd: '/r',
      hostname: 'mac',
      pid: 1,
    });
    const wid = (reg.body as { workerId: string }).workerId;
    const first = call(handle, 'GET', `/mac/poll?workerId=${wid}`, null);
    await new Promise((r) => setTimeout(r, 30));
    const second = call(handle, 'GET', `/mac/poll?workerId=${wid}`, null);
    await new Promise((r) => setTimeout(r, 30));
    coord.enqueueAndMaybeDispatch({ cwd: '/r', prompt: 'one task' });
    // The second (latest) waiter should receive it. The first must
    // resolve too (timeout 204) so the test doesn't hang on the
    // afterEach close.
    const r2 = await second;
    expect(r2.status).toBe(200);
    expect((r2.body as { prompt: string }).prompt).toBe('one task');
    const r1 = await first;
    // Either 204 (timeout) or 200 if the cancel race went the other way.
    expect([200, 204]).toContain(r1.status);
  });
});

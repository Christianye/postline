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

interface Fetched {
  status: number;
  body: unknown;
  headers: Record<string, string>;
}

async function call(
  handle: DoorbellServerHandle,
  method: string,
  path: string,
  body: Record<string, unknown> | null,
  opts: { secret?: string; tsOverride?: number; sigOverride?: string } = {},
): Promise<Fetched> {
  const ts = opts.tsOverride ?? Date.now();
  const bodyText = body ? JSON.stringify(body) : '';
  const sig =
    opts.sigOverride ??
    sign({
      method,
      path,
      body: bodyText,
      ts,
      secret: opts.secret ?? SECRET,
    });
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
  const headers: Record<string, string> = {};
  res.headers.forEach((v, k) => {
    headers[k] = v;
  });
  return { status: res.status, body: parsed, headers };
}

describe('DoorbellServer — endpoints + auth', () => {
  let coord: DoorbellCoordinator;
  let handle: DoorbellServerHandle;

  beforeEach(async () => {
    coord = new DoorbellCoordinator({ log: silentLogger() });
    handle = await startDoorbellServer({
      coordinator: coord,
      secret: SECRET,
      host: '127.0.0.1',
      port: 0,
      log: silentLogger(),
    });
  });

  afterEach(async () => {
    await handle.close();
    coord.stop();
  });

  it('rejects requests with missing HMAC headers (400 missing_header)', async () => {
    const url = `http://${handle.address.host}:${handle.address.port}/mac/poll?workerId=x`;
    const res = await fetch(url);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('missing_header');
  });

  it('rejects bad signature with 401', async () => {
    const r = await call(handle, 'GET', '/mac/poll?workerId=x', null, {
      sigOverride: 'a'.repeat(64),
    });
    expect(r.status).toBe(401);
    expect((r.body as { error: string }).error).toBe('bad_signature');
  });

  it('rejects ts skew beyond window with 403', async () => {
    const r = await call(handle, 'GET', '/mac/poll?workerId=x', null, {
      tsOverride: Date.now() - 5 * 60_000,
    });
    expect(r.status).toBe(403);
    expect((r.body as { error: string }).error).toBe('ts_skew');
  });

  it('register → poll round-trip dispatches a queued task', async () => {
    const reg = await call(handle, 'POST', '/mac/register', {
      cwd: '/repo',
      hostname: 'mac',
      pid: 1,
      registeredAt: Date.now(),
    });
    expect(reg.status).toBe(200);
    const { workerId, state } = reg.body as { workerId: string; state: string };
    expect(state).toBe('active');

    coord.queue.enqueue({ cwd: '/repo', prompt: 'do this' });

    const poll = await call(handle, 'GET', `/mac/poll?workerId=${workerId}`, null);
    expect(poll.status).toBe(200);
    const task = poll.body as { taskId: string; prompt: string; cwd: string };
    expect(task.prompt).toBe('do this');
    expect(task.cwd).toBe('/repo');
    expect(task.taskId).toMatch(/^[0-9a-f]{4}$/);
  });

  it('poll returns 204 when the worker has nothing queued', async () => {
    const reg = await call(handle, 'POST', '/mac/register', {
      cwd: '/r',
      hostname: 'mac',
      pid: 1,
    });
    const { workerId } = reg.body as { workerId: string };
    const poll = await call(handle, 'GET', `/mac/poll?workerId=${workerId}`, null);
    expect(poll.status).toBe(204);
  });

  it('poll on a standby worker returns 409 status:standby', async () => {
    const r1 = await call(handle, 'POST', '/mac/register', {
      cwd: '/r',
      hostname: 'mac',
      pid: 1,
    });
    const w1 = (r1.body as { workerId: string }).workerId;
    // Register a second worker for the same cwd, demoting w1.
    await call(handle, 'POST', '/mac/register', { cwd: '/r', hostname: 'mac2', pid: 2 });
    const poll = await call(handle, 'GET', `/mac/poll?workerId=${w1}`, null);
    expect(poll.status).toBe(409);
    expect((poll.body as { status: string }).status).toBe('standby');
  });

  it('poll on unknown workerId returns 401', async () => {
    const r = await call(handle, 'GET', '/mac/poll?workerId=w_unknown', null);
    expect(r.status).toBe(401);
  });

  it('poll without workerId returns 400', async () => {
    const r = await call(handle, 'GET', '/mac/poll', null);
    expect(r.status).toBe(400);
  });

  it('progress posts succeed for the task owner; 403 for impostors', async () => {
    const reg = await call(handle, 'POST', '/mac/register', {
      cwd: '/r',
      hostname: 'mac',
      pid: 1,
    });
    const wid = (reg.body as { workerId: string }).workerId;
    coord.queue.enqueue({ cwd: '/r', prompt: 'p' });
    const poll = await call(handle, 'GET', `/mac/poll?workerId=${wid}`, null);
    const tid = (poll.body as { taskId: string }).taskId;

    const ok = await call(handle, 'POST', '/mac/progress', {
      taskId: tid,
      workerId: wid,
      summary: 'reading file',
    });
    expect(ok.status).toBe(200);

    const impostor = await call(handle, 'POST', '/mac/progress', {
      taskId: tid,
      workerId: 'w_other',
      summary: 'evil',
    });
    expect(impostor.status).toBe(403);
  });

  it('result with status:ok marks task done; status:failed marks failed', async () => {
    const reg = await call(handle, 'POST', '/mac/register', {
      cwd: '/r',
      hostname: 'mac',
      pid: 1,
    });
    const wid = (reg.body as { workerId: string }).workerId;
    coord.queue.enqueue({ cwd: '/r', prompt: 'p' });
    const poll = await call(handle, 'GET', `/mac/poll?workerId=${wid}`, null);
    const tid = (poll.body as { taskId: string }).taskId;

    const r = await call(handle, 'POST', '/mac/result', {
      taskId: tid,
      workerId: wid,
      status: 'ok',
      text: 'done',
    });
    expect(r.status).toBe(200);
    expect(coord.queue.get(tid)?.status).toBe('done');

    // Second task → failed.
    coord.queue.enqueue({ cwd: '/r', prompt: 'p2' });
    const poll2 = await call(handle, 'GET', `/mac/poll?workerId=${wid}`, null);
    const tid2 = (poll2.body as { taskId: string }).taskId;
    await call(handle, 'POST', '/mac/result', {
      taskId: tid2,
      workerId: wid,
      status: 'failed',
      errorMessage: 'oops',
    });
    expect(coord.queue.get(tid2)?.status).toBe('failed');
  });

  it('register with malformed body returns 400', async () => {
    const r = await call(handle, 'POST', '/mac/register', { cwd: '/r' });
    expect(r.status).toBe(400);
  });

  it('unknown route returns 404', async () => {
    const r = await call(handle, 'GET', '/nope', null);
    expect(r.status).toBe(404);
  });

  it('demoted worker can still post result for its in-flight task (M3)', async () => {
    const reg1 = await call(handle, 'POST', '/mac/register', {
      cwd: '/r',
      hostname: 'mac',
      pid: 1,
    });
    const w1 = (reg1.body as { workerId: string }).workerId;
    coord.queue.enqueue({ cwd: '/r', prompt: 'p' });
    const poll = await call(handle, 'GET', `/mac/poll?workerId=${w1}`, null);
    const tid = (poll.body as { taskId: string }).taskId;

    // Second worker demotes w1.
    await call(handle, 'POST', '/mac/register', { cwd: '/r', hostname: 'mac2', pid: 2 });

    // w1 (now standby) still posts result; lock allows it.
    const r = await call(handle, 'POST', '/mac/result', {
      taskId: tid,
      workerId: w1,
      status: 'ok',
      text: 'done',
    });
    expect(r.status).toBe(200);
    expect(coord.queue.get(tid)?.status).toBe('done');
  });
});

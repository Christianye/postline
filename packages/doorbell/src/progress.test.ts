import type { Logger } from '@postline/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DoorbellCoordinator } from './coordinator.js';
import { sign } from './hmac.js';
import { type DoorbellServerHandle, startDoorbellServer } from './server.js';
import type { Task } from './types.js';

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
  url: string,
  method: string,
  path: string,
  body: Record<string, unknown> | null,
): Promise<{ status: number; body: unknown }> {
  const ts = Date.now();
  const bodyText = body ? JSON.stringify(body) : '';
  const sig = sign({ method, path, body: bodyText, ts, secret: SECRET });
  const res = await fetch(`${url}${path}`, {
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

describe('Doorbell progress + terminal hooks (PR-DB-4)', () => {
  let coord: DoorbellCoordinator;
  let handle: DoorbellServerHandle;
  let url: string;
  let progressEvents: Array<{ task: Task; summary?: string; etaSeconds?: number }>;
  let terminalEvents: Array<{ task: Task; text?: string; errorMessage?: string }>;

  beforeEach(async () => {
    progressEvents = [];
    terminalEvents = [];
    coord = new DoorbellCoordinator({
      log: silentLogger(),
      onTaskProgress: (e) => {
        progressEvents.push(e);
      },
      onTaskTerminal: (e) => {
        terminalEvents.push(e);
      },
    });
    handle = await startDoorbellServer({
      coordinator: coord,
      secret: SECRET,
      host: '127.0.0.1',
      port: 0,
      longPollTimeoutMs: 100,
      log: silentLogger(),
    });
    url = `http://${handle.address.host}:${handle.address.port}`;
  });

  afterEach(async () => {
    await handle.close();
    coord.stop();
  });

  async function setupRunningTask(): Promise<{ workerId: string; taskId: string }> {
    const reg = await call(url, 'POST', '/mac/register', {
      cwd: '/r',
      hostname: 'mac',
      pid: 1,
    });
    const wid = (reg.body as { workerId: string }).workerId;
    coord.queue.enqueue({ cwd: '/r', prompt: 'p' });
    const poll = await call(url, 'GET', `/mac/poll?workerId=${wid}`, null);
    const tid = (poll.body as { taskId: string }).taskId;
    return { workerId: wid, taskId: tid };
  }

  it('progress POST fires onTaskProgress with task + summary + eta', async () => {
    const { workerId, taskId } = await setupRunningTask();
    const r = await call(url, 'POST', '/mac/progress', {
      taskId,
      workerId,
      summary: 'reading file...',
      etaSeconds: 45,
    });
    expect(r.status).toBe(200);
    expect(progressEvents).toHaveLength(1);
    expect(progressEvents[0]?.task.taskId).toBe(taskId);
    expect(progressEvents[0]?.summary).toBe('reading file...');
    expect(progressEvents[0]?.etaSeconds).toBe(45);
  });

  it('ETA > 3600s is rejected at the boundary (server-side validate)', async () => {
    const { workerId, taskId } = await setupRunningTask();
    await call(url, 'POST', '/mac/progress', {
      taskId,
      workerId,
      etaSeconds: 9999,
    });
    expect(progressEvents).toHaveLength(1);
    expect(progressEvents[0]?.etaSeconds).toBeUndefined();
  });

  it('ETA <= 0 is rejected', async () => {
    const { workerId, taskId } = await setupRunningTask();
    await call(url, 'POST', '/mac/progress', { taskId, workerId, etaSeconds: 0 });
    await call(url, 'POST', '/mac/progress', { taskId, workerId, etaSeconds: -5 });
    expect(progressEvents).toHaveLength(2);
    expect(progressEvents[0]?.etaSeconds).toBeUndefined();
    expect(progressEvents[1]?.etaSeconds).toBeUndefined();
  });

  it('non-numeric ETA is rejected', async () => {
    const { workerId, taskId } = await setupRunningTask();
    await call(url, 'POST', '/mac/progress', {
      taskId,
      workerId,
      etaSeconds: 'soon' as unknown as number,
    });
    expect(progressEvents).toHaveLength(1);
    expect(progressEvents[0]?.etaSeconds).toBeUndefined();
  });

  it('result POST status:ok fires onTaskTerminal with text', async () => {
    const { workerId, taskId } = await setupRunningTask();
    const r = await call(url, 'POST', '/mac/result', {
      taskId,
      workerId,
      status: 'ok',
      text: 'final answer',
    });
    expect(r.status).toBe(200);
    expect(terminalEvents).toHaveLength(1);
    expect(terminalEvents[0]?.task.taskId).toBe(taskId);
    expect(terminalEvents[0]?.task.status).toBe('done');
    expect(terminalEvents[0]?.text).toBe('final answer');
  });

  it('result POST status:failed fires terminal with errorMessage', async () => {
    const { workerId, taskId } = await setupRunningTask();
    await call(url, 'POST', '/mac/result', {
      taskId,
      workerId,
      status: 'failed',
      errorMessage: 'exit 1: oops',
    });
    expect(terminalEvents).toHaveLength(1);
    expect(terminalEvents[0]?.task.status).toBe('failed');
    expect(terminalEvents[0]?.errorMessage).toBe('exit 1: oops');
  });

  it('result POST status:timeout fires terminal with status=timeout', async () => {
    const { workerId, taskId } = await setupRunningTask();
    await call(url, 'POST', '/mac/result', {
      taskId,
      workerId,
      status: 'timeout',
      errorMessage: 'task exceeded deadline',
    });
    expect(terminalEvents[0]?.task.status).toBe('timeout');
  });

  it('hook errors are caught and never break the request', async () => {
    const c = new DoorbellCoordinator({
      log: silentLogger(),
      onTaskProgress: () => {
        throw new Error('hook boom');
      },
    });
    const h = await startDoorbellServer({
      coordinator: c,
      secret: SECRET,
      host: '127.0.0.1',
      port: 0,
      longPollTimeoutMs: 100,
      log: silentLogger(),
    });
    const u = `http://${h.address.host}:${h.address.port}`;
    try {
      const reg = await call(u, 'POST', '/mac/register', {
        cwd: '/r',
        hostname: 'mac',
        pid: 1,
      });
      const wid = (reg.body as { workerId: string }).workerId;
      c.queue.enqueue({ cwd: '/r', prompt: 'p' });
      const poll = await call(u, 'GET', `/mac/poll?workerId=${wid}`, null);
      const tid = (poll.body as { taskId: string }).taskId;
      const r = await call(u, 'POST', '/mac/progress', { taskId: tid, workerId: wid });
      expect(r.status).toBe(200);
    } finally {
      await h.close();
      c.stop();
    }
  });
});

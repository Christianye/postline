import type { StreamChunk } from '@postline/core';
import { describe, expect, it, vi } from 'vitest';
import { isContentChunk, isRetryableError, runModelChain, withRetry } from './retry.js';

async function collect(it: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const out: StreamChunk[] = [];
  for await (const c of it) out.push(c);
  return out;
}

describe('isContentChunk', () => {
  it('counts text/thinking/tool_use chunks as content', () => {
    for (const type of [
      'text_delta',
      'thinking_delta',
      'tool_use_start',
      'tool_use_delta',
      'tool_use_end',
    ] as const) {
      expect(isContentChunk({ type })).toBe(true);
    }
  });
  it('does not count control chunks (status/done/error)', () => {
    for (const type of ['status', 'done', 'error'] as const) {
      expect(isContentChunk({ type })).toBe(false);
    }
  });
});

describe('runModelChain — at-most-once content (fallback duplication fix)', () => {
  const sig = new AbortController().signal;

  it('falls back when the first model fails BEFORE emitting content', async () => {
    const attempts: string[] = [];
    const out = await collect(
      runModelChain(['m1', 'm2'], sig, {
        stripPrefix: (x) => x,
        streamOne: (modelId) =>
          (async function* () {
            attempts.push(modelId);
            if (modelId === 'm1') throw new Error('cold fail');
            yield { type: 'text_delta', text: 'hi from m2' } as StreamChunk;
          })(),
      }),
    );
    expect(attempts).toEqual(['m1', 'm2']);
    expect(out).toEqual([{ type: 'text_delta', text: 'hi from m2' }]);
  });

  it('does NOT fall back after content was emitted — emits error+done instead', async () => {
    const attempts: string[] = [];
    const out = await collect(
      runModelChain(['m1', 'm2'], sig, {
        stripPrefix: (x) => x,
        streamOne: (modelId) =>
          (async function* () {
            attempts.push(modelId);
            yield { type: 'text_delta', text: 'partial' } as StreamChunk;
            throw new Error('mid-stream fail');
          })(),
      }),
    );
    // m2 was never tried — no duplication.
    expect(attempts).toEqual(['m1']);
    expect(out[0]).toEqual({ type: 'text_delta', text: 'partial' });
    expect(out[1]?.type).toBe('error');
    expect(out[2]).toMatchObject({ type: 'done', stopReason: 'error' });
  });

  it('emits all-failed terminal chunks when every model fails cold', async () => {
    const out = await collect(
      runModelChain(['m1', 'm2'], sig, {
        stripPrefix: (x) => x,
        streamOne: () =>
          (async function* () {
            throw new Error('nope');
            // biome-ignore lint/correctness/useYield: test generator that only throws
          })(),
      }),
    );
    expect(out[0]?.type).toBe('error');
    expect(out[0]?.error).toMatch(/All models failed/);
    expect(out[1]).toMatchObject({ type: 'done', stopReason: 'error' });
  });
});

function namedErr(name: string, extras: Record<string, unknown> = {}): Error {
  const e = new Error(`${name} thrown`);
  e.name = name;
  Object.assign(e, extras);
  return e;
}

describe('isRetryableError', () => {
  it('treats abort as permanent', () => {
    expect(isRetryableError(namedErr('AbortError'))).toBe(false);
    expect(isRetryableError(namedErr('APIUserAbortError'))).toBe(false);
  });

  it('classifies bedrock-named transient errors as retryable', () => {
    for (const name of [
      'ThrottlingException',
      'ServiceUnavailableException',
      'InternalServerException',
      'ModelTimeoutException',
      'ModelStreamErrorException',
    ]) {
      expect(isRetryableError(namedErr(name))).toBe(true);
    }
  });

  it('classifies bedrock-named permanent errors as non-retryable', () => {
    for (const name of [
      'ValidationException',
      'AccessDeniedException',
      'ResourceNotFoundException',
      'ConflictException',
    ]) {
      expect(isRetryableError(namedErr(name))).toBe(false);
    }
  });

  it('classifies anthropic-named transient errors as retryable', () => {
    for (const name of ['RateLimitError', 'InternalServerError', 'APIConnectionError']) {
      expect(isRetryableError(namedErr(name))).toBe(true);
    }
  });

  it('classifies anthropic-named permanent errors as non-retryable', () => {
    for (const name of [
      'BadRequestError',
      'AuthenticationError',
      'PermissionDeniedError',
      'NotFoundError',
      'UnprocessableEntityError',
    ]) {
      expect(isRetryableError(namedErr(name))).toBe(false);
    }
  });

  it('falls back to status code: 429 + 5xx retryable; 4xx not', () => {
    expect(isRetryableError(namedErr('SomeOddError', { status: 429 }))).toBe(true);
    expect(isRetryableError(namedErr('SomeOddError', { status: 503 }))).toBe(true);
    expect(isRetryableError(namedErr('SomeOddError', { status: 500 }))).toBe(true);
    expect(isRetryableError(namedErr('SomeOddError', { status: 400 }))).toBe(false);
    expect(isRetryableError(namedErr('SomeOddError', { status: 404 }))).toBe(false);
  });

  it('classifies low-level node network errors via code', () => {
    expect(isRetryableError(namedErr('Error', { code: 'ECONNRESET' }))).toBe(true);
    expect(isRetryableError(namedErr('Error', { code: 'ETIMEDOUT' }))).toBe(true);
    expect(isRetryableError(namedErr('Error', { code: 'ENOENT' }))).toBe(false);
  });

  it('treats null / non-objects as non-retryable', () => {
    expect(isRetryableError(null)).toBe(false);
    expect(isRetryableError(undefined)).toBe(false);
    expect(isRetryableError('string error')).toBe(false);
  });
});

describe('withRetry', () => {
  it('returns first-attempt success without retrying', async () => {
    const fn = vi.fn(async () => 'ok');
    const out = await withRetry(fn);
    expect(out).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries on retryable error and resolves on the second attempt', async () => {
    let calls = 0;
    const out = await withRetry(
      async () => {
        calls += 1;
        if (calls === 1) throw namedErr('ThrottlingException');
        return 'recovered';
      },
      { baseDelayMs: 1, maxAttempts: 3 },
    );
    expect(out).toBe('recovered');
    expect(calls).toBe(2);
  });

  it('does not retry permanent errors', async () => {
    const fn = vi.fn(async () => {
      throw namedErr('ValidationException');
    });
    await expect(withRetry(fn, { baseDelayMs: 1 })).rejects.toThrow();
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('does not retry abort errors', async () => {
    const fn = vi.fn(async () => {
      throw namedErr('AbortError');
    });
    await expect(withRetry(fn, { baseDelayMs: 1 })).rejects.toThrow();
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('exhausts max attempts and rethrows the last error', async () => {
    const fn = vi.fn(async () => {
      throw namedErr('ThrottlingException');
    });
    await expect(withRetry(fn, { baseDelayMs: 1, maxAttempts: 3 })).rejects.toMatchObject({
      name: 'ThrottlingException',
    });
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('aborts cleanly mid-backoff if the signal fires', async () => {
    const ctl = new AbortController();
    const fn = vi.fn(async () => {
      throw namedErr('ThrottlingException');
    });
    const p = withRetry(fn, { baseDelayMs: 200, maxAttempts: 3, signal: ctl.signal });
    setTimeout(() => ctl.abort(), 20);
    await expect(p).rejects.toThrow();
    // Only the first attempt should have run; abort fired during backoff.
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('logs each retry attempt with provider_retry', async () => {
    const warn = vi.fn();
    const log = {
      info: vi.fn(),
      warn,
      error: vi.fn(),
      debug: vi.fn(),
      child() {
        return log;
      },
    };
    let calls = 0;
    await withRetry(
      async () => {
        calls += 1;
        if (calls < 2) throw namedErr('RateLimitError');
        return 'ok';
      },
      { baseDelayMs: 1, log, logCtx: { provider: 'anthropic', model: 'claude-x' } },
    );
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'anthropic',
        model: 'claude-x',
        attempt: 1,
        errName: 'RateLimitError',
      }),
      'provider_retry',
    );
  });
});

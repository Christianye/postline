import { describe, expect, it, vi } from 'vitest';
import { isRetryableError, withRetry } from './retry.js';

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

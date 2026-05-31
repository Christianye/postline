import type { Logger } from '@postline/core';

/**
 * Classify a thrown error as retryable (transient infrastructure / throttle /
 * upstream timeout) vs permanent (4xx client error, abort, model-not-found).
 *
 * Naming-based rather than instance-based so we don't have to import every
 * SDK's error class hierarchy here. The naming aligns across the two SDKs we
 * use today:
 *
 *   - Bedrock SDK error classes: ThrottlingException, ServiceUnavailableException,
 *     InternalServerException, ModelTimeoutException, ModelNotReadyException,
 *     ModelStreamErrorException
 *   - Anthropic SDK error classes: RateLimitError (429), InternalServerError
 *     (5xx), APIConnectionError, APIConnectionTimeoutError
 *   - Node low-level: errors with `code` ECONNRESET / ETIMEDOUT / ECONNREFUSED /
 *     EAI_AGAIN / EPIPE
 *
 * Permanent (NEVER retry):
 *   - APIUserAbortError / AbortError / DOMException with name=AbortError
 *   - ValidationException / BadRequestError (4xx schema/input issues)
 *   - AccessDeniedException / AuthenticationError / PermissionDeniedError
 *   - ResourceNotFoundException / NotFoundError (model id wrong)
 *   - UnprocessableEntityError (422)
 */
export function isRetryableError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { name?: string; code?: string; status?: number; message?: string };
  const name = e.name ?? '';
  // Aborts always non-retryable.
  if (name === 'AbortError' || name === 'APIUserAbortError') return false;
  // Permanent client errors.
  if (
    name === 'ValidationException' ||
    name === 'BadRequestError' ||
    name === 'AccessDeniedException' ||
    name === 'AuthenticationError' ||
    name === 'PermissionDeniedError' ||
    name === 'ResourceNotFoundException' ||
    name === 'NotFoundError' ||
    name === 'UnprocessableEntityError' ||
    name === 'ConflictException' ||
    name === 'ConflictError'
  ) {
    return false;
  }
  // Retryable Bedrock-shaped names.
  if (
    name === 'ThrottlingException' ||
    name === 'ServiceUnavailableException' ||
    name === 'ServiceQuotaExceededException' ||
    name === 'InternalServerException' ||
    name === 'ModelTimeoutException' ||
    name === 'ModelNotReadyException' ||
    name === 'ModelStreamErrorException' ||
    name === 'TimeoutError'
  ) {
    return true;
  }
  // Retryable Anthropic-shaped names.
  if (
    name === 'RateLimitError' ||
    name === 'InternalServerError' ||
    name === 'APIConnectionError' ||
    name === 'APIConnectionTimeoutError'
  ) {
    return true;
  }
  // Status-code fallback for APIError subclasses or generic HTTP errors.
  if (typeof e.status === 'number') {
    if (e.status === 429) return true;
    if (e.status >= 500 && e.status < 600) return true;
    if (e.status >= 400 && e.status < 500) return false;
  }
  // Node low-level network errors.
  const code = e.code ?? '';
  if (
    code === 'ECONNRESET' ||
    code === 'ETIMEDOUT' ||
    code === 'ECONNREFUSED' ||
    code === 'EAI_AGAIN' ||
    code === 'EPIPE'
  ) {
    return true;
  }
  return false;
}

export interface RetryOptions {
  /** Total attempts including the first call. Default 3 (= 2 retries). */
  maxAttempts?: number;
  /** Base backoff in ms; doubles per attempt (exponential, base 4). Default 100. */
  baseDelayMs?: number;
  /** Cap on a single backoff window. Default 5000. */
  maxDelayMs?: number;
  /**
   * AbortSignal. If aborted between attempts the loop exits immediately and
   * rethrows the AbortError without further sleeps.
   */
  signal?: AbortSignal;
  /** Optional structured logger; emits `provider_retry` per retry attempt. */
  log?: Logger;
  /** Free-form context attached to every log line, e.g. `{ provider, model }`. */
  logCtx?: Record<string, unknown>;
  /**
   * Optional hook fired once per retry (NOT on the initial attempt). Used by
   * provider implementations to bump a `provider_retry_total` metric without
   * having to plumb the registry through this module.
   */
  onRetry?: (attempt: number) => void;
}

/**
 * Run `fn` with retry-on-transient. Only HTTP-level transient errors are
 * retried — anything caller code yielded as a stream chunk has already left
 * this function, so retrying after partial output would duplicate content.
 *
 * Resolves with `fn`'s return value, or rejects with the LAST error after
 * exhausting attempts.
 */
export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const maxAttempts = opts.maxAttempts ?? 3;
  const baseDelay = opts.baseDelayMs ?? 100;
  const maxDelay = opts.maxDelayMs ?? 5000;
  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      if (opts.signal?.aborted) throw e;
      if (attempt >= maxAttempts || !isRetryableError(e)) throw e;
      // Exponential backoff base 4: 100, 400, 1600, ...
      const delay = Math.min(maxDelay, baseDelay * 4 ** (attempt - 1));
      opts.log?.warn(
        {
          ...(opts.logCtx ?? {}),
          attempt,
          maxAttempts,
          delayMs: delay,
          err: (e as Error).message,
          errName: (e as Error).name,
        },
        'provider_retry',
      );
      try {
        opts.onRetry?.(attempt);
      } catch {
        // never let metric / hook errors mask the underlying retryable error
      }
      await sleep(delay, opts.signal);
    }
  }
  throw lastErr;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('aborted during retry backoff'));
      return;
    }
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(new Error('aborted during retry backoff'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

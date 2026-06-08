import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Doorbell request authentication.
 *
 * Per design §6.2 / RF7 trust model: HMAC over `(method, path, body, ts)`
 * with a shared 32-byte secret stored 0600 in `~/.cc-dev/.env` on both
 * ends. A 60-second timestamp window prevents passive replay across
 * networks. The secret is the entire trust boundary — a holder can do
 * anything; that's an intentional simplification.
 */

export interface SignParams {
  /** HTTP method, uppercase: 'GET' / 'POST'. */
  method: string;
  /** Request path including query string, e.g. `/mac/poll?workerId=W1`. */
  path: string;
  /** Raw request body bytes; empty string for GET. */
  body: string;
  /** ms since epoch. The signer's clock; verifier compares with its own. */
  ts: number;
  /** 32+ byte ASCII secret. */
  secret: string;
}

export interface VerifyParams extends Omit<SignParams, 'ts'> {
  /** ts as provided by the client header (string before parseInt). */
  tsHeader: string;
  /** Signature header value the client sent. */
  signatureHeader: string;
  /** Verifier's wall-clock (ms). Defaulted to `Date.now()` if not in tests. */
  now?: number;
  /** Allowed clock-skew window in ms. Default 60_000 (60s). */
  windowMs?: number;
}

export type VerifyResult =
  | { ok: true }
  | { ok: false; reason: 'missing_header' | 'malformed_ts' | 'ts_skew' | 'bad_signature' };

const DEFAULT_WINDOW_MS = 60_000;

/** Canonical string the signature is computed over. */
function canonicalize(params: Omit<SignParams, 'secret'>): string {
  return `${params.method.toUpperCase()}\n${params.path}\n${params.body}\n${params.ts}`;
}

/** Hex-encoded HMAC-SHA256. */
export function sign(params: SignParams): string {
  const mac = createHmac('sha256', params.secret);
  mac.update(canonicalize(params));
  return mac.digest('hex');
}

/**
 * Constant-time verify of a request signature against the configured
 * secret. Returns a tagged result so callers can pick the right HTTP
 * status (400 for malformed, 401 for bad signature, 403 for skew).
 */
export function verify(params: VerifyParams): VerifyResult {
  if (!params.tsHeader || !params.signatureHeader) {
    return { ok: false, reason: 'missing_header' };
  }
  const ts = Number.parseInt(params.tsHeader, 10);
  if (!Number.isFinite(ts) || ts <= 0) {
    return { ok: false, reason: 'malformed_ts' };
  }
  const now = params.now ?? Date.now();
  const windowMs = params.windowMs ?? DEFAULT_WINDOW_MS;
  if (Math.abs(now - ts) > windowMs) {
    return { ok: false, reason: 'ts_skew' };
  }
  const expected = sign({
    method: params.method,
    path: params.path,
    body: params.body,
    ts,
    secret: params.secret,
  });
  // Different lengths (e.g. operator ships a hex sig of wrong length) would
  // crash timingSafeEqual; bail explicitly.
  if (expected.length !== params.signatureHeader.length) {
    return { ok: false, reason: 'bad_signature' };
  }
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(params.signatureHeader, 'utf8');
  return timingSafeEqual(a, b) ? { ok: true } : { ok: false, reason: 'bad_signature' };
}

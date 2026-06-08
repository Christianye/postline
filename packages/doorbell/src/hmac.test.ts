import { describe, expect, it } from 'vitest';
import { sign, verify } from './hmac.js';

const SECRET = 'POSTLINE_DOORBELL_TEST_SECRET_32_BYTES_OPAQUE';

describe('sign', () => {
  it('produces a stable hex digest for the same inputs', () => {
    const a = sign({ method: 'GET', path: '/mac/poll', body: '', ts: 1, secret: SECRET });
    const b = sign({ method: 'GET', path: '/mac/poll', body: '', ts: 1, secret: SECRET });
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it('changes when any input changes', () => {
    const base = sign({ method: 'GET', path: '/mac/poll', body: '', ts: 1, secret: SECRET });
    expect(sign({ method: 'POST', path: '/mac/poll', body: '', ts: 1, secret: SECRET })).not.toBe(
      base,
    );
    expect(
      sign({ method: 'GET', path: '/mac/register', body: '', ts: 1, secret: SECRET }),
    ).not.toBe(base);
    expect(sign({ method: 'GET', path: '/mac/poll', body: 'x', ts: 1, secret: SECRET })).not.toBe(
      base,
    );
    expect(sign({ method: 'GET', path: '/mac/poll', body: '', ts: 2, secret: SECRET })).not.toBe(
      base,
    );
    expect(
      sign({ method: 'GET', path: '/mac/poll', body: '', ts: 1, secret: 'different' }),
    ).not.toBe(base);
  });

  it('uppercases method internally so `get` and `GET` sign identically', () => {
    const a = sign({ method: 'get', path: '/x', body: '', ts: 1, secret: SECRET });
    const b = sign({ method: 'GET', path: '/x', body: '', ts: 1, secret: SECRET });
    expect(a).toBe(b);
  });
});

describe('verify', () => {
  function ts(): number {
    return 1_700_000_000_000;
  }

  function makeSig(over: { method?: string; path?: string; body?: string; t?: number } = {}): {
    sig: string;
    method: string;
    path: string;
    body: string;
    t: number;
  } {
    const method = over.method ?? 'GET';
    const path = over.path ?? '/mac/poll';
    const body = over.body ?? '';
    const t = over.t ?? ts();
    return {
      sig: sign({ method, path, body, ts: t, secret: SECRET }),
      method,
      path,
      body,
      t,
    };
  }

  it('accepts a freshly-signed valid request', () => {
    const { sig, method, path, body, t } = makeSig();
    const result = verify({
      method,
      path,
      body,
      tsHeader: String(t),
      signatureHeader: sig,
      secret: SECRET,
      now: t,
    });
    expect(result).toEqual({ ok: true });
  });

  it('rejects requests with missing headers', () => {
    const baseline = makeSig();
    expect(
      verify({
        method: baseline.method,
        path: baseline.path,
        body: baseline.body,
        tsHeader: '',
        signatureHeader: baseline.sig,
        secret: SECRET,
        now: baseline.t,
      }),
    ).toEqual({ ok: false, reason: 'missing_header' });
    expect(
      verify({
        method: baseline.method,
        path: baseline.path,
        body: baseline.body,
        tsHeader: String(baseline.t),
        signatureHeader: '',
        secret: SECRET,
        now: baseline.t,
      }),
    ).toEqual({ ok: false, reason: 'missing_header' });
  });

  it('rejects malformed tsHeader', () => {
    const { sig, method, path, body, t } = makeSig();
    expect(
      verify({
        method,
        path,
        body,
        tsHeader: 'not-a-number',
        signatureHeader: sig,
        secret: SECRET,
        now: t,
      }),
    ).toEqual({ ok: false, reason: 'malformed_ts' });
  });

  it('rejects ts skew beyond the default 60s window', () => {
    const { sig, method, path, body, t } = makeSig();
    expect(
      verify({
        method,
        path,
        body,
        tsHeader: String(t),
        signatureHeader: sig,
        secret: SECRET,
        now: t + 61_000,
      }),
    ).toEqual({ ok: false, reason: 'ts_skew' });
    expect(
      verify({
        method,
        path,
        body,
        tsHeader: String(t),
        signatureHeader: sig,
        secret: SECRET,
        now: t - 61_000,
      }),
    ).toEqual({ ok: false, reason: 'ts_skew' });
  });

  it('respects custom windowMs', () => {
    const { sig, method, path, body, t } = makeSig();
    expect(
      verify({
        method,
        path,
        body,
        tsHeader: String(t),
        signatureHeader: sig,
        secret: SECRET,
        now: t + 5_000,
        windowMs: 1_000,
      }),
    ).toEqual({ ok: false, reason: 'ts_skew' });
  });

  it('rejects bad signature without crashing on length mismatch', () => {
    const { method, path, body, t } = makeSig();
    expect(
      verify({
        method,
        path,
        body,
        tsHeader: String(t),
        signatureHeader: 'tooshort',
        secret: SECRET,
        now: t,
      }),
    ).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('rejects signatures forged with the wrong secret', () => {
    const { method, path, body, t } = makeSig();
    const forged = sign({ method, path, body, ts: t, secret: 'wrong-secret' });
    expect(
      verify({
        method,
        path,
        body,
        tsHeader: String(t),
        signatureHeader: forged,
        secret: SECRET,
        now: t,
      }),
    ).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('rejects body tampering even when signature header is valid for a different body', () => {
    const baseline = makeSig({ body: 'alpha' });
    expect(
      verify({
        method: baseline.method,
        path: baseline.path,
        body: 'beta', // attacker swaps body but reuses signature
        tsHeader: String(baseline.t),
        signatureHeader: baseline.sig,
        secret: SECRET,
        now: baseline.t,
      }),
    ).toEqual({ ok: false, reason: 'bad_signature' });
  });
});

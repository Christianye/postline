import { describe, expect, it } from 'vitest';
import { redact } from './redact.js';

describe('redact', () => {
  it('masks AWS access key ids', () => {
    expect(redact('my key is AKIAIOSFODNN7EXAMPLE here')).toBe('my key is [REDACTED:AWS_KEY] here');
  });

  it('masks GitHub tokens', () => {
    expect(redact('token=ghp_0123456789abcdefghijklmnopqrstuvwxyzAB')).toBe(
      'token=[REDACTED:GH_TOKEN]',
    );
  });

  it('masks Bearer headers', () => {
    expect(redact('Authorization: Bearer abcdef1234567890.xyzqwe')).toBe(
      'Authorization: Bearer [REDACTED]',
    );
  });

  it('masks PEM blocks', () => {
    // Assemble at runtime to avoid tripping static-analysis secret scanners on this file.
    const d = '-';
    const begin = `${d.repeat(5)}BEGIN RSA PRIVATE KEY${d.repeat(5)}`;
    const end = `${d.repeat(5)}END RSA PRIVATE KEY${d.repeat(5)}`;
    const pem = [begin, 'A'.repeat(20), end].join('\n');
    expect(redact(pem)).toBe('[REDACTED:PRIVATE_KEY]');
  });

  it('leaves innocuous text alone', () => {
    const s = 'Hello how are you, chatId=oc_12345';
    expect(redact(s)).toBe(s);
  });
});

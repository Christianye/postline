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

  // SECURITY (audit 2026-06-17): patterns for the keys most likely present on
  // a worker host. Values assembled at runtime to avoid tripping secret
  // scanners on this file.
  it('masks Anthropic API keys', () => {
    const k = `sk-ant-${'a1b2C3d4'.repeat(5)}`;
    expect(redact(`key: ${k}`)).toBe('key: [REDACTED:ANTHROPIC_KEY]');
  });

  it('masks OpenAI-style keys', () => {
    const k = `sk-${'X9y8Z7w6'.repeat(4)}`;
    expect(redact(`OPENAI_API_KEY=${k}`)).toBe('OPENAI_API_KEY=[REDACTED:API_KEY]');
  });

  it('masks Slack tokens (xoxb/xapp/xoxp)', () => {
    const bot = `xoxb-${'1234567890'.repeat(2)}`;
    const app = `xapp-${'abcdef0123'.repeat(2)}`;
    expect(redact(`bot=${bot} app=${app}`)).toBe(
      'bot=[REDACTED:SLACK_TOKEN] app=[REDACTED:SLACK_TOKEN]',
    );
  });

  it('masks fine-grained GitHub tokens (github_pat_)', () => {
    const k = `github_pat_${'A1b2C3d4e5'.repeat(3)}`;
    expect(redact(`token ${k}`)).toBe('token [REDACTED:GH_TOKEN]');
  });

  it('masks an AWS secret with the keyword BEFORE the value (old lookahead missed this)', () => {
    const secret = 'wJalrXUtnFEMIK7MDENGbPxRfiCYEXAMPLEKEY12'; // 40 chars
    expect(redact(`aws_secret_access_key = ${secret}`)).toBe(
      'aws_secret_access_key = [REDACTED:AWS_SECRET]',
    );
  });

  it('masks lowercased AWS access key ids', () => {
    expect(redact('akiaiosfodnn7example')).toBe('[REDACTED:AWS_KEY]');
  });

  it('leaves innocuous text alone', () => {
    const s = 'Hello how are you, chatId=oc_12345';
    expect(redact(s)).toBe(s);
  });

  it('does not over-redact a normal 40-char hex git sha with no keyword nearby', () => {
    const sha = 'a'.repeat(40);
    const s = `commit ${sha} landed`;
    expect(redact(s)).toBe(s);
  });
});

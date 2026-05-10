/**
 * Post-process assistant output to strip secrets that may have leaked
 * through memory / workspace / tool results.
 */
const PATTERNS: readonly { re: RegExp; replace: string }[] = [
  // AWS access keys
  { re: /\b(AKIA|ASIA|AGPA|AROA|AIPA)[A-Z0-9]{16}\b/g, replace: '[REDACTED:AWS_KEY]' },
  // AWS secret access keys (40 chars, base64-ish)
  { re: /\b(?:[A-Za-z0-9+/]{40})\b(?=.*(?:secret|key))/gi, replace: '[REDACTED:AWS_SECRET]' },
  // GitHub tokens
  { re: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g, replace: '[REDACTED:GH_TOKEN]' },
  // Feishu app secret (exactly 32 alphanumerics adjacent to "secret")
  {
    re: /\b[A-Za-z0-9]{32}\b(?=[^\n]*(?:secret|Secret|SECRET))/g,
    replace: '[REDACTED:FEISHU_SECRET]',
  },
  // Bearer tokens
  { re: /\bBearer\s+[A-Za-z0-9\-_.]{20,}/g, replace: 'Bearer [REDACTED]' },
  // Private key PEM blocks
  {
    re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]+?-----END [A-Z ]*PRIVATE KEY-----/g,
    replace: '[REDACTED:PRIVATE_KEY]',
  },
];

export function redact(input: string): string {
  let out = input;
  for (const { re, replace } of PATTERNS) {
    out = out.replace(re, replace);
  }
  return out;
}

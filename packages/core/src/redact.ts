/**
 * Post-process assistant output to strip secrets that may have leaked
 * through memory / workspace / tool results.
 */
const PATTERNS: readonly { re: RegExp; replace: string }[] = [
  // Anthropic / Claude API keys (sk-ant-…) — the key most likely present on
  // a worker host. Must come before the generic sk- pattern.
  { re: /\bsk-ant-[A-Za-z0-9_-]{20,}/g, replace: '[REDACTED:ANTHROPIC_KEY]' },
  // OpenAI-style keys (sk-…, sk-proj-…). Broad but bounded length.
  { re: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}/g, replace: '[REDACTED:API_KEY]' },
  // Slack tokens: xoxb-/xoxp-/xoxa-/xoxr-/xoxs-/xoxe- (Web API) + xapp-
  // (app-level / Socket Mode).
  { re: /\b(?:xox[baprse]|xapp)-[A-Za-z0-9-]{8,}/g, replace: '[REDACTED:SLACK_TOKEN]' },
  // GitHub tokens — classic (ghp_/gho_/ghu_/ghs_/ghr_) AND fine-grained
  // (github_pat_…). The old `gh[pousr]_` could not match github_pat_.
  { re: /\bgithub_pat_[A-Za-z0-9_]{22,}/g, replace: '[REDACTED:GH_TOKEN]' },
  { re: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g, replace: '[REDACTED:GH_TOKEN]' },
  // AWS access keys (case-insensitive — lowercased keys still leak the id).
  { re: /\b(AKIA|ASIA|AGPA|AROA|AIPA)[A-Z0-9]{16}\b/gi, replace: '[REDACTED:AWS_KEY]' },
  // AWS secret access keys: a 40-char base64-ish blob near an
  // aws/secret/key keyword on the SAME line, in EITHER order (the old
  // forward-only lookahead missed `aws_secret_access_key = <value>`).
  {
    re: /((?:aws|secret|access|key)[\w-]*\s*[:=]\s*)[A-Za-z0-9+/]{40}(?![A-Za-z0-9+/])/gi,
    replace: '$1[REDACTED:AWS_SECRET]',
  },
  {
    re: /\b([A-Za-z0-9+/]{40})(?![A-Za-z0-9+/])(?=[^\n]*(?:secret|access|aws|key))/gi,
    replace: '[REDACTED:AWS_SECRET]',
  },
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

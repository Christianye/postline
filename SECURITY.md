# Security Policy

## Supported versions

postline is in the `0.x` pre-1.0 phase. Only the latest `main` branch gets security fixes.

## Reporting a vulnerability

**Don't open a public GitHub issue.** Instead:

- Email: **security@example.com** with the subject `postline security <short-description>`
- Expect a response within 5 business days
- We prefer coordinated disclosure — we'll work with you on a fix timeline before any public advisory

## Scope

In scope:

- Prompt injection that causes the bot to leak secrets from memory, exec tools beyond its risk tier, or impersonate allowlisted users
- Any path allowing non-allowlisted users to trigger `risk: write` or `risk: dangerous` tools
- Bypass of the `/approve` gate for dangerous tools
- Secret leakage via logs, error messages, or tool responses
- SSRF in `web_fetch` (RFC1918, cloud metadata, localhost)
- Auth bypass in provider adapters

Out of scope:

- Vulnerabilities in third-party services (AWS Bedrock, Anthropic API, Feishu OpenAPI) — report to the vendor
- Anything requiring physical access to the user's machine
- Social engineering of the operator
- Missing rate limits when the operator has configured the bot without any allowlist (this is by-design self-service mode)

## Threat model

Read [`docs/THREAT_MODEL.md`](docs/THREAT_MODEL.md) — 8 enumerated threats with current mitigations.

## Hall of fame

Contributors who reported valid vulnerabilities (with permission):

_(none yet)_

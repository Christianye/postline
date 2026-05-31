---
'@postline/providers': patch
---

Add HTTP-level retry with exponential backoff to both `bedrock` and `anthropic` providers. Transient infrastructure errors (Throttling, ServiceUnavailable, InternalServer, RateLimit, network ECONNRESET / ETIMEDOUT, etc.) now retry up to 2 times per model attempt before falling through to the next fallback model. Permanent errors (Validation, AccessDenied, NotFound, abort) bypass retry as before.

Backoff is exponential with base 4: 100ms, 400ms, 1600ms (capped at 5s). Retries are bounded to the HTTP send only — once stream iteration starts, any error there falls back to the next model unchanged, since chunks already yielded would otherwise duplicate.

Each retry logs `provider_retry` with `{provider, model, attempt, delayMs, errName, err}` so quota / throttle bursts are visible in journalctl.

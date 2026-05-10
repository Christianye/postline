---
name: Bug report
about: Something in postline doesn't work as described
title: 'bug: <short summary>'
labels: bug
---

## What happened

<!-- One or two sentences describing the bug. -->

## Reproduction

Steps:

1. …
2. …
3. …

Config (redact secrets):

```ts
// paste the relevant parts of your postline.config.ts
```

## Expected behavior

<!-- What you thought would happen. -->

## Observed behavior

<!-- What actually happened. Paste journalctl / stderr output if available. -->

## Environment

- postline version / commit: <!-- `git rev-parse HEAD` -->
- Node: <!-- `node --version` -->
- OS: <!-- `uname -a` -->
- Provider: bedrock / anthropic
- Channel: feishu / cli

## Have you checked

- [ ] `pnpm test` still passes locally
- [ ] No obvious secret leaked in the logs above
- [ ] Not a duplicate of an open issue

## Additional context

<!-- Screenshots, logs, related issues, etc. -->

---
'@postline/adapters-cli': patch
---

feat(onboarding): routing.md starter, docker worker docs, first-message self-intro

Finishes the chapter-5 onboarding deliverables:

- **routing.md starter template.** New `docs/routing.example.md` (annotated,
  copy-paste) + `postline init` now drops a minimal `routing.md` into the
  memory dir (committed by the same git-init) so a new user has something to
  edit instead of a blank file. Next-steps point at it.
- **Docker dispatch docs.** `deploy/docker/README.md` gains a "Dispatching to
  a cc-worker" section — the container is the bridge; workers run on the repo
  host and tunnel to the loopback doorbell. Previously the docker path only
  documented the bridge, leaving "how do I actually run code" unanswered.
- **First-message self-intro.** The `reject_no_worker` reply (where an
  unprompted "hi" or a keyword-miss lands) now reads as a one-line self-intro
  + the dispatch shape (`!pl@<repo> …`) instead of a terse rejection. Shared
  `onboardingHint()` so feishu/telegram/slack greet identically.

+3 tests (onboardingHint). 805 total. init routing.md scaffold verified live.

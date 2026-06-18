# routing.md — starter template

Copy this to your memory dir as `routing.md` (postline reads
`<memory.dir>/routing.md`, or `cfg.router.routingMdPath`). `postline init`
drops a starter copy there for you. Edit the worker_aliases to point at your
own repos and you're done — the bridge hot-reloads on save, no restart.

postline matches each inbound message against the sections below to decide:
**dispatch to a cc-worker**, answer locally (only if `embeddedLlm.enabled`),
or reject with a hint. The minimal useful routing.md is just `## projects`
+ `## worker_aliases`.

---

## wake
pl

<!-- The wake-name for override prefixes: `!pl@<repo>`, `!pl@<selector>@<repo>`.
     One lowercase token [a-z0-9-]. Default `pl` if this section is omitted.
     Reserved words `ec2` / `plain` are rejected (they're mode sub-keywords). -->

## projects
- acme-api
- acme-web
- notes

<!-- Anchor names postline recognises in a message. Mentioning `acme-api`
     routes to the worker aliased below. These are just the keywords; the
     path mapping is in worker_aliases. -->

## worker_aliases
acme-api → /home/dev/code/acme-api
acme-web → /home/dev/code/acme-web
notes    → /home/dev/code/notes

<!-- project name → absolute cwd of the repo a cc-worker runs in. This is the
     one section you must edit for your own repos. `!pl@acme-api …` dispatches
     to whatever worker registered for that cwd. (Legacy alias for this
     section name: `## cwd_aliases`.) -->

## dispatch_to_mac
- path token: ~/, ./, *.ts, *.py, *.go, *.md, *.rs
- repo verbs: repo, branch, commit, "PR #", merge, rebase, git
- toolchain: pnpm, npm, vitest, biome, build, lint
- explicit verbs: review, debug, refactor, 看代码, 改, 跑测试

<!-- Signals that a message is a coding task → dispatch to a worker. Tune to
     your stack. -->

## destructive_verbs
- deploy
- "rm -rf"
- "force push"
- "drop table"
- "git push --force"

<!-- When a message looks destructive AND no worker is registered, postline
     refuses rather than guessing. -->

<!-- Optional, only used when embeddedLlm.enabled = true:

## ec2_self_solve
- web_fetch: 查 docs, http(s)://...
- github remote queries

## ec2_direct_answer
- chitchat / greetings
- concept questions: 什么是, 解释
-->

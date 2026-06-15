---
'@postline/core': patch
---

fix(router): accept `## worker_aliases` section name in routing.md

The parser only recognised `## cwd_aliases`, but the reframe docs, README,
and `wake-prefix-redesign` all tell users to write `## worker_aliases`.
A routing.md following the docs parsed to zero aliases, so `!pl@<repo>`
dispatch resolved no cwd and replied "no repo resolved".

`worker_aliases` is now the canonical section name; `cwd_aliases` stays as
a back-compat alias. Caught live while wiring up the telegram bridge.

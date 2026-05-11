# FAQ

## Why Feishu/Lark only?

Because that's where the operator lives. Feishu is the primary messenger for the target audience (Chinese product / engineering teams, plus bilingual outfits with overseas offices). Slack bots are a crowded space; a well-engineered Claude bot for Feishu is not.

The `Channel` interface is real and will not be broken — if you want Slack, Discord, Telegram, the scaffolding is there. See [ROADMAP](ROADMAP.md) phase 3.

## Why Claude only? No GPT/Gemini/local models?

The model behaviour — tool-use loop, streaming shape, prompt-caching semantics, vision handling — is designed against Claude's API. Supporting other models means either:

1. Lose features (prompt caching, thinking tokens, fine-grained tool streaming), or
2. Write an adapter layer per provider that constantly plays catch-up.

We picked option 3: pick the model we actually use and go deep. Phase 2c roadmap notes which community provider PRs are welcome — they have to match the Claude capability surface (streaming + tool use + vision) or they won't merge.

## Why not just use Claude Code in a terminal?

You can, for yourself. postline is for the case where:

- You want an always-on presence in a group chat, not a session you launch.
- Teammates who don't use Claude Code should still be able to `@bot` and get answers.
- You want cron-triggered prompts (daily reports, build summaries) without anyone's laptop being open.
- You want tool outputs to land in the chat your team already reads, not a terminal.

It's complementary to Claude Code, not a replacement.

## How is this different from Dify / Coze / LangChain?

- **Dify / Coze**: hosted visual workflow builders. postline is a Node process you run. No UI, no workflow graph, no vendor account.
- **LangChain**: general-purpose LLM toolkit. postline is one opinionated bot, not a framework. We intentionally do *not* have chains, agents, or retrievers as abstractions.
- **Raw Feishu webhook bots**: no model loop, no tool use, no streaming. postline handles all three.

See [COMPARISON.md](COMPARISON.md) for the full matrix.

## Is it safe to let the bot run `bash` in my Feishu group?

By default the `bash` tool is `dangerous` — each call requires an interactive `/approve <id>` from an allowlisted user before it runs. The `bash_read` tool is auto-approved but only matches a classifier-validated read-only subset (`git log`, `ls`, `cat`, `ps aux`, etc. — the full list is in `packages/tools-builtin/src/bash-read-allowlist.ts`). Writes, pipes into `sh`, and `exec` are rejected.

Read [SECURITY.md](../SECURITY.md) and [THREAT_MODEL.md](THREAT_MODEL.md) before deploying.

## Why Node 22+? My machine has 20 LTS.

Two reasons:

1. Native `--experimental-strip-types` means `postline.config.ts` loads without a bundler. Node 20 can't do this.
2. Node 22 is the current LTS. 20 reaches maintenance by late 2026.

If you're stuck on 20, you can compile `postline.config.ts` to `.js` yourself and point `POSTLINE_CONFIG` at it. Not tested by CI.

## Why not publish to npm?

Eventually, yes. Not for 0.1.0. Reasons:

- Until the four core interfaces are stress-tested by contributors, we'd rather break them in `main` than burn semver patches.
- pnpm workspace + git clone is the recommended install path during 0.x — it matches how we develop and deploy.
- npm publication implies a support commitment we're not ready to make.

Tracking under [ROADMAP](ROADMAP.md) — sometime in the 0.2.x line.

## Do you store my messages / prompts?

postline runs on *your* machine or *your* cloud. Nothing is sent anywhere except:

- The LLM provider you configured (AWS Bedrock or Anthropic API).
- Feishu (for message delivery — your own bot, your own workspace).
- Any explicit tool call you authorise (`web_fetch`, `gh_query`, etc.).

Full outbound host list is in [THREAT_MODEL.md § Network surface](THREAT_MODEL.md).

## The bot stopped responding. What first?

```bash
postline doctor              # checks env, deps, config, provider reachability
journalctl -u cc -n 200      # if deployed via systemd
```

Common causes, in order of frequency:

1. Bedrock / Anthropic API auth expired or quota exceeded.
2. Feishu long-connection dropped and hasn't reconnected — restart `cc.service`.
3. `postline.config.ts` has a syntax error and loader fell back to env-only mode with an empty tool list. `postline doctor` flags this.

## Can I run multiple postline instances?

Yes — each instance needs its own:

- Feishu app (`app_id` / `app_secret`).
- allowlist.
- memory git remote (optional, but recommended — don't share memory between bots).

Running two instances against the same Feishu app is undefined behaviour (both will receive every event).

## How do I contribute?

Read [CONTRIBUTING.md](../CONTRIBUTING.md). The short version:

1. Open a Discussion before anything larger than ~200 lines.
2. PRs must have the five-section description: Why / What / Test / Risk / Invariants.
3. Don't change the four core interfaces without a Discussion first — that's how we keep the promise of stability.

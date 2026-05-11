# postline vs. the alternatives

Honest table. Written by postline authors — biased by construction, but we'll call out where the alternatives win.

## At a glance

| | postline | Raw Feishu webhook | [Dify](https://dify.ai) | [Coze](https://www.coze.com) | [LangChain](https://www.langchain.com) + own wiring | [OpenClaw](https://github.com/openclaw/openclaw) |
|---|---|---|---|---|---|---|
| Runs on | Your Node process | Your HTTP endpoint | Dify cloud or self-hosted | Coze cloud (ByteDance) | Your Python/JS process | Your shell (CLI) |
| Streaming LLM output | ✅ | Up to you | ✅ | ✅ | ✅ | ✅ |
| Tool use loop (multi-turn) | ✅ built-in | ❌ DIY | ✅ | ✅ | ✅ (verbose) | ✅ |
| Vision (image input) | ✅ | DIY | ✅ | ✅ | ✅ | ✅ |
| Feishu / Lark native | ✅ long-connection | ✅ webhook | Via plugin | Via plugin | DIY | ❌ |
| Slack / Discord / Telegram | Community roadmap | DIY per platform | ✅ | ✅ | ✅ (wrappers) | ❌ |
| Always-on in a group chat | ✅ | ✅ | Via integration | Via integration | DIY | ❌ (session) |
| Cron-triggered prompts | ✅ `postline ask` | DIY | ✅ scheduled runs | ✅ | DIY | ❌ |
| Model provider | Claude (Bedrock / Anthropic) | Any | Many | Doubao / GPT / Claude | Many | Claude |
| Risk-tiered tool gating | ✅ read/write/dangerous | — | Role-based | Role-based | DIY | Per-tool approve |
| Git-backed memory | ✅ | DIY | Dataset feature | Knowledge base | DIY | DIY |
| Self-hosted, no cloud account | ✅ | ✅ | ✅ (OSS image) | ❌ | ✅ | ✅ |
| Code lines you maintain | ~0 (config file) | Hundreds | ~0 (UI) | ~0 (UI) | Hundreds | ~0 (CLI user) |
| License | MIT | — | [Dify Open Source License](https://github.com/langgenius/dify/blob/main/LICENSE) (modified Apache 2.0) | Proprietary SaaS | MIT | MIT |

## When to pick what

### Pick **postline** when

- Your team is on **Feishu/Lark**, you want a 24/7 bot, you care about code-level control.
- You already use **Claude** (via Bedrock or Anthropic API) and want to go deep on prompt caching, tool use, vision.
- You want the bot to run arbitrary shell / git / GitHub / Feishu-doc / web-fetch operations with per-tier approval.
- You're comfortable with Node, pnpm, systemd. You'd rather write a config file than click through a UI.
- Your definition of "memory" is "commit some markdown to a git repo."

### Pick a **raw Feishu webhook bot** when

- You only need to receive a message and reply with a fixed string or a single LLM call.
- You have ~200 lines of tolerance for boilerplate and don't need streaming.
- You don't want any framework at all.

### Pick **Dify** when

- You want a **visual workflow builder** and your team is comfortable with UI-driven logic.
- You need RAG with an embedded vector DB and a document upload UI.
- You need multi-tenant / workspace features out of the box.
- You want to swap models through dropdowns, not code.

Dify wins on: no-code surface, RAG UX, built-in observability dashboards.
Dify loses on: Claude-specific features (prompt caching shape, thinking tokens), writing a Feishu adapter from a UI, debugging via "look at the workflow graph" versus grep-able code.

### Pick **Coze** when

- You're in China, you want Doubao/豆包 as the default model, and you're OK running on ByteDance's cloud.
- You want to ship a bot to multiple Feishu tenants as a product, not for your own team.
- You don't want to operate infrastructure at all.

Coze wins on: managed everything, marketplace, Doubao integration.
Coze loses on: source code access, self-hosting, using Claude as the primary model.

### Pick **LangChain + your own wiring** when

- You need a framework abstraction (chains, retrievers, agents with more than one strategy).
- Your use case spans four providers, three vector DBs, and two chat platforms.
- You're building a framework yourself and need primitives.

LangChain wins on: breadth, ecosystem, research velocity.
LangChain loses on: opinionated simplicity, maintenance cost of a many-abstractions codebase.

### Pick **OpenClaw** when

- You want a **terminal-first** Claude session with plugins, not a chat bot.
- You work solo and need Claude in your shell, not in a group chat.

OpenClaw wins on: personal CLI workflow.
OpenClaw loses on: channel delivery (it doesn't run in Feishu/Slack/etc), always-on semantics.

*postline and OpenClaw are orthogonal — you can use both. In fact, early postline ancestry is from a separate project that adapted to OpenClaw's CLI; see [git history](https://github.com/Christianye/postline/commits/main).*

## Things postline intentionally does **not** do

If you need any of the below, postline is wrong for you — pick an alternative:

- Visual workflow editor.
- Vector database / embedding RAG.
- Multi-tenant SaaS hosting.
- Arbitrary LLM provider.
- No-code tool composition.

See [ROADMAP § Non-goals](ROADMAP.md#non-goals).

## Last word

Tools disagree with each other because the underlying tradeoffs are real. If you're choosing between these, ask: *who's on the operator side, who's on the user side, and which side is the UI built for?* postline builds for the operator; Dify and Coze build for the no-code composer; LangChain builds for the framework author. There's no single right answer.

# About postline

> The missing IM connector for Claude Code.

## What it is, in one paragraph

postline is a small bridge daemon. You add it to your Feishu / Lark / Telegram bot, point it at a GitHub repo where you have a `docs/designs/` directory, and start a `cc-worker` skill inside any Claude Code session — on your Mac, on an EC2 box reachable via SSM, anywhere. From then on, you can `@cc` from your phone and the message routes to the right CC session by repo. Progress streams back into the same IM message in place. The CC worker does the actual work; postline carries bytes between your IM and the worker.

It is *not* an agent. It does not have a memory of its own. It does not run an LLM by default. It is a router with a Feishu adapter and a worker registry.

## Why this shape

Most "AI in your IM" projects bolt the model into the bot itself. The bot becomes a separate agent: separate context, separate tool surface, separate identity. You end up maintaining two agents — the one in your IDE and the one in your IM — and reconciling them every time something changes.

postline picks the opposite shape: **the bot does not have a brain. The brain is your CC.**

This works because Claude Code already gives you everything an agent needs:
- A model (Bedrock or Anthropic API).
- Tool access (skills, MCP servers, shell, fs, web, gh).
- Memory (your `~/.claude/memory` repo).
- Identity continuity (working style, preferences, persona on disk).

What was missing — and the only thing postline adds — is **a way to reach that CC session from outside the terminal**. Your IM is the obvious channel; everyone already lives there.

## How it actually works

```
                  ┌──────────────────────┐
                  │ user (Feishu / Lark) │
                  └──────────┬───────────┘
                             │  @cc 改 postline 的 routing 段
                             ▼
       ┌─────────────────────────────────────────┐
       │  postline (bridge daemon)               │
       │  ─ IM adapter (feishu / lark / ...)     │
       │  ─ Router (routing.md, no LLM by def)   │
       │  ─ Worker registry, queue, HMAC         │
       │  ─ (optional) embedded LLM for          │
       │     simple Q&A — config-toggled, OFF    │
       │     by default                          │
       └────────────┬────────────────────────────┘
                    │   SSM port-forwarded HTTP, HMAC
                    ▼
   ┌─────────────────────────────────────────────┐
   │  CC workers (any number, any host)          │
   │                                             │
   │  ┌───────────────┐    ┌──────────────────┐  │
   │  │ mac CC        │    │ ec2 CC           │  │
   │  │ (interactive  │    │ (interactive,    │  │
   │  │  in iTerm2)   │    │  via tmux+SSM)   │  │
   │  │ + cc-worker   │    │ + cc-worker      │  │
   │  │   skill       │    │   skill          │  │
   │  └───────────────┘    └──────────────────┘  │
   │     cwd=postline         cwd=NeuGate        │
   │                                             │
   │  workers identify by (host, cwd) tuple;     │
   │  IM messages auto-route to the right one    │
   │  by repo keyword, or via                    │
   │  `!cc:<repo>@<host>` override.              │
   └─────────────────────────────────────────────┘
```

## What it gives you over plain Claude Code

Claude Code is excellent for sitting at your laptop and writing code with an agent. postline adds two things:

1. **You can reach your CC from anywhere.** Phone, tablet, group chat, the random other person who also has access to the bot. Same agent, same memory, just a different surface. You don't have to be at the keyboard.

2. **One bot, many CCs.** Different repos, different hosts. Mention `postline` in Feishu and the message goes to the worker registered for the postline repo. Mention `NeuGate` and it goes to a different worker. `!cc:postline@ec2` if you specifically want the EC2 one. The bot is a switchboard.

## What you give up

- **Postline does not run when no CC is active.** That's the trade-off for "no embedded LLM by default". If your Mac is asleep and you ask postline to do something, it'll tell you "no worker for this request, start a CC worker." The Telegram message you sent at 2am doesn't get a magic answer at 3am.
- **You manage your own CC.** postline doesn't install Claude Code for you, doesn't manage your provider credentials, doesn't decide which model to use. Whatever your interactive CC is, that's what postline delegates to.
- **No multi-tenant.** One operator per deployment. The allowlist is by `open_id`, the routing rules are global, the bot has one personality (yours).

## Where it fits in your stack

- **You already use Claude Code daily.** postline sits next to it.
- **Your team uses Feishu / Lark / Telegram for everyday chat.** postline drops a bot in.
- **You want IDE-grade work to be reachable from IM-grade context.** That's the gap.

If you don't use Claude Code, postline is the wrong tool — you'd be paying for the bridge without the brains it bridges to. If your work is entirely conversational ("write me a haiku"), a regular bot framework is simpler. postline is for the case where the work needs your repo / your shell / your tool access.

## How development works

postline is single-operator-developed (currently by [Christianye](https://github.com/Christianye)) but reads as if it were team-built — every substantive feature has a written design RFC under `docs/designs/`, every multi-PR sprint has its own sprint plan under `docs/SPRINT_PLAN_*.md`, every commit references the spec section it implements. The two CCs that built it (one on Mac, one on EC2) follow a `protocol_cc_division.md` for who owns what.

If you read the source you'll find the structure feels heavy for a side project. That's intentional: this codebase is itself dogfood — postline is built using postline (a Mac CC opens design RFCs and ships PRs; the EC2 bridge daemon is what reviews them).

## The shortest possible version

You have a CC. You want to talk to it from your phone. postline is the bot you put in your IM, and the protocol that lets your CC pick up its messages.

That's it.

---

For the full positioning + roadmap, see [`docs/designs/postline-reframe.md`](docs/designs/postline-reframe.md).
For the protocol spec, see [`docs/designs/doorbell.md`](docs/designs/doorbell.md).
For the sprint tracker, see [`docs/SPRINT_PLAN_DOORBELL.md`](docs/SPRINT_PLAN_DOORBELL.md).

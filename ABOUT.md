# About postline

> Your AI coding agent, in your pocket — and built to extend.

## What it is, in one paragraph

postline is a lightweight, extensible mobile front-end for AI coding agents. You add it to your Feishu / Lark / Telegram / Slack bot and start a `cc-worker` skill inside any Claude Code or Codex session — on your Mac, on an EC2 box reachable via SSM, anywhere. From then on, you drive that agent from your phone: `@cc` a task, it routes to the right session by repo, progress streams back into the same IM message in place, the result lands where you're already looking. The agent does the actual work; postline is the surface that puts it one chat message away.

It is pluggable on two axes. The **IM axis** — Feishu / Lark, Telegram, Slack — is a `Channel` interface; a new messenger is one implementation. The **agent axis** — Claude Code, Codex — is a worker agent-kind; `!pl@<selector>@<repo>` picks which one handles a message. And the **model layer is optional**: by default postline holds no LLM and delegates to the agent on your host, but flip `embedded_llm.enabled` and the bot answers simple queries itself. Same codebase, pure-bridge or self-contained, your choice.

## Why this shape

Most "AI in your IM" projects bolt one model into the bot itself. The bot becomes a second, separate agent: separate context, separate tool surface, separate identity. You end up maintaining two agents — the one in your IDE and the one in your IM — and reconciling them every time something changes.

postline picks a different shape: **by default the brain isn't in the bot — it's the agent you already run.** The bot is the pocket-sized front-end; the intelligence stays wherever your Claude Code / Codex session lives.

This works because those agents already give you everything an agent needs:
- A model (Bedrock or Anthropic API for CC; whatever backs your Codex).
- Tool access (skills, MCP servers, shell, fs, web, gh) — all reachable over IM untouched.
- Memory (your `~/.claude/memory` repo).
- Identity continuity (working style, preferences, persona on disk).

What was missing — and what postline adds — is **a way to reach that session from outside the terminal, and a small set of seams to extend along** (another IM, another agent-kind, or an embedded model when you want the bot to stand alone). Your IM is the obvious surface; everyone already lives there, phone included.

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
   │     cwd=postline         cwd=acme-api        │
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

2. **One bot, many CCs.** Different repos, different hosts. Mention `postline` in Feishu and the message goes to the worker registered for the postline repo. Mention `acme-api` and it goes to a different worker. `!cc:postline@ec2` if you specifically want the EC2 one. The bot is a switchboard.

## What you give up

- **By default, real work needs a live worker.** That's the trade-off for the no-embedded-LLM default. If your Mac is asleep and you dispatch a task, postline replies "no worker for this request, start a cc-worker" rather than faking an answer. (Flip on the embedded LLM and the bot can field trivial queries on its own — but it still won't touch your repo without a worker.)
- **You manage your own CC.** postline doesn't install Claude Code for you, doesn't manage your provider credentials, doesn't decide which model to use. Whatever your interactive CC is, that's what postline delegates to.
- **No multi-tenant.** One operator per deployment. The allowlist is by `open_id`, the routing rules are global, the bot has one personality (yours).

## Where it fits in your stack

- **You already use Claude Code or Codex daily.** postline sits next to it and puts it on your phone.
- **Your team uses Feishu / Lark / Telegram / Slack for everyday chat.** postline drops a bot in — pick the IM, or add one.
- **You want IDE-grade work to be reachable from IM-grade context.** That's the gap.

If you use no coding agent at all, postline is the wrong tool by default — you'd be paying for the front-end without the brains behind it (though the embedded LLM can stand in for light Q&A). If your work is entirely conversational ("write me a haiku"), a regular bot framework is simpler. postline is for the case where the work needs your repo / your shell / your tool access — reached from your pocket.

## How development works

postline is single-operator-developed (currently by [Christianye](https://github.com/Christianye)) but reads as if it were team-built — every substantive feature has a written design RFC under `docs/designs/`, every multi-PR sprint has its own sprint plan under `docs/SPRINT_PLAN_*.md`, every commit references the spec section it implements. The two Claude instances that built it (one on a Mac, one on an EC2 box) follow a written division-of-ownership protocol for who owns what.

If you read the source you'll find the structure feels heavy for a side project. That's intentional: this codebase is itself dogfood — postline is built using postline (a Mac CC opens design RFCs and ships PRs; the EC2 bridge daemon is what reviews them).

## The shortest possible version

You have a coding agent. You want to drive it from your phone. postline is the bot you put in your IM, the protocol that lets your agent pick up its messages — and the seams to add another IM, another agent, or an embedded model when you need them.

That's it.

---

For the full positioning + roadmap, see [`docs/designs/postline-reframe.md`](docs/designs/postline-reframe.md).
For the protocol spec, see [`docs/designs/doorbell.md`](docs/designs/doorbell.md).
For the sprint tracker, see [`docs/SPRINT_PLAN_DOORBELL.md`](docs/SPRINT_PLAN_DOORBELL.md).

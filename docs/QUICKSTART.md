# Quickstart — 5 minutes to `@cc` from your phone

postline bridges an IM (Telegram / Slack / Feishu) to a **Claude Code** (or
Codex) session running on your machine. You message the bot; it dispatches the
work to a `cc-worker` registered for the repo; progress streams back into the
same message. postline itself holds no LLM — your CC does the work.

This walkthrough uses **Telegram** (the fastest start — a token from
[@BotFather](https://t.me/BotFather), no app to create). Other channels are a
one-line swap at the end.

You'll end with: a bot you DM `!pl@<repo> …` and your local Claude Code runs it.

---

## 1. Install

```bash
git clone https://github.com/Christianye/postline.git
cd postline
pnpm install && pnpm -r build
```

## 2. Scaffold config

```bash
node packages/cli/dist/bin.js init --channel telegram
```

This creates `postline.config.ts` (from the example) + a git-backed memory dir,
and prints channel-tailored next steps. Open `postline.config.ts` and:

- uncomment the **`telegram`** block — add your numeric Telegram user id to
  `allowlist` (message [@userinfobot](https://t.me/userinfobot) to find it);
- uncomment the **`doorbell`** block (`enabled: true`) — this is what lets the
  bridge dispatch to a worker.

## 3. Credentials

```bash
export CC_TELEGRAM_BOT_TOKEN=123456:ABC...        # from @BotFather
export ANTHROPIC_API_KEY=sk-ant-...               # or configure AWS for Bedrock
export CC_DOORBELL_SECRET=$(openssl rand -hex 32) # shared between bridge + worker
```

> Tokens go in the environment, never in the committed config — postline reads
> `CC_TELEGRAM_BOT_TOKEN` / `CC_DOORBELL_SECRET` directly.

## 4. Start the bridge

```bash
node packages/cli/dist/bin.js telegram
```

In another terminal, confirm the dispatch path is healthy:

```bash
node packages/cli/dist/bin.js doctor
# [  ok] doorbell   doorbell up at http://localhost:9999, 0 worker(s) registered
#  → or: "no worker registered — run cc-worker start" until you do step 5
```

## 5. Register a worker + test it

On the host that has the repo checked out (same machine is fine):

```bash
export CC_DOORBELL_URL=http://localhost:9999
export CC_DOORBELL_SECRET=<same value as step 3>
cd /path/to/the/repo/you/want/@cc-able
node /path/to/postline/packages/cli/dist/bin.js cc-worker start
```

Now DM your Telegram bot:

```
!pl@<repo> echo hello from my CC
```

…where `<repo>` is the repo's folder name. You should see the message update
in place: `🟡 running` → the worker's reply → `🟢 done`. That's the loop.

`postline doctor` should now report **`doorbell up … 1 worker(s) registered`**.

---

## Worker environment variables

A `cc-worker` reads these from its environment:

| Var | Required | Meaning |
|---|---|---|
| `CC_DOORBELL_URL` | ✅ | Bridge address (e.g. `http://localhost:9999`; an SSM/SSH tunnel target if the bridge is on another host). |
| `CC_DOORBELL_SECRET` | ✅ | Must match the bridge's `doorbell.secret`. |
| `CC_WORKER_AGENT_KIND` | — | `cc` (default) or `codex` — which agent backs this worker. |
| `CC_WORKER_SHOW_THINKING` | — | `1` to stream a `💭 thinking` line into the IM. |

---

## Other channels

Same flow; only the bridge command + token env + config block change:

| Channel | Bridge command | Token env | Setup note |
|---|---|---|---|
| **Telegram** | `postline telegram` | `CC_TELEGRAM_BOT_TOKEN` | @BotFather — fastest. |
| **Slack** | `postline slack` | `CC_SLACK_APP_TOKEN` + `CC_SLACK_BOT_TOKEN` | Socket Mode app (app + bot token). |
| **Feishu / Lark** | `postline feishu` | `POSTLINE_FEISHU_APP_SECRET` (+ `appId` in config) | Create a Feishu app first. |

Run `postline init --channel slack` (or `feishu`) to get next-steps for that
channel. You can run multiple bridges as separate processes (each on its own
doorbell port) if you want more than one IM.

---

See [`docs/cc-worker.md`](cc-worker.md) for the worker in depth,
[`deploy/README.md`](../deploy/README.md) for 24/7 deployment, and
[`docs/COMPARISON.md`](COMPARISON.md) / [`docs/FAQ.md`](FAQ.md) to decide if
postline fits.

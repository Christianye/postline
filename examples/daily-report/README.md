# example: daily-report

A scheduled `postline ask` run that pushes a daily GitHub digest into a feishu group. Demonstrates the unattended-workflow pattern: single turn, narrow tool set, `feishu_send` with an explicit allowlist.

## What it produces

Every weekday at 09:00 Beijing time, the bot:

1. Calls `gh_query` twice (merged PRs + touched issues in the last 24h)
2. Writes a 6-10 line Chinese summary
3. Calls `feishu_send` to post it to your status group

No human in the loop. No dangerous tools loaded. No memory writes — single-shot.

## Setup

```bash
# From the repo root
cp examples/daily-report/postline.config.ts .
# edit the new postline.config.ts:
#   - feishu.appId to your cli_... app id
#   - feishu_send.sendAllowlist to your status group's oc_... id
#   - the PROMPT inside daily-report.sh (org/repo, target chat_id)

export ANTHROPIC_API_KEY=sk-ant-xxx
export POSTLINE_FEISHU_APP_SECRET=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx

# One-off dry run (prints the summary + "sent to oc_..." line):
bash examples/daily-report/daily-report.sh
```

## Schedule

Pick one:

**crontab** (per-user, survives reboots):

```cron
0 9 * * 1-5  cd $HOME/postline && bash examples/daily-report/daily-report.sh >> $HOME/postline-daily.log 2>&1
```

**systemd timer** (if you already have the `cc.service` unit installed):

```ini
# /etc/systemd/system/daily-report.service
[Unit]
Description=Daily feishu report via postline
After=network-online.target

[Service]
Type=oneshot
User=<YOU>
WorkingDirectory=/home/<YOU>/postline
EnvironmentFile=/home/<YOU>/.cc/env
ExecStart=/usr/bin/env bash examples/daily-report/daily-report.sh
```

```ini
# /etc/systemd/system/daily-report.timer
[Unit]
Description=Run daily-report at 09:00 weekdays

[Timer]
OnCalendar=Mon..Fri 09:00
Persistent=true

[Install]
WantedBy=timers.target
```

```bash
sudo systemctl enable --now daily-report.timer
```

## Why `ask` + not `feishu`

`postline feishu` is for interactive bots that react to inbound messages. `postline ask` is for outbound workflows that you trigger from cron / CI / shell. It shares the same provider, tools, and memory — just skips the WebSocket listener and exits after one turn.

## Failure modes you should know

- `gh auth status` expired → `gh_query` returns an error, model aborts before calling `feishu_send`
- `sendAllowlist` missing the target chat_id → `feishu_send` returns `ERROR: target ... is not on feishu.sendAllowlist`
- `POSTLINE_FEISHU_APP_SECRET` unset → validateConfig fails at load
- Rate limit (5/min default) → second call in the same minute returns `rate limit` error

All of these surface in the log redirect (`postline-daily.log`). Check it after the first scheduled run.

## Next step

Once this works, try a weekly retrospective (`OnCalendar=Fri 17:00`), or wire a monitoring probe that calls `ask` on a health-check prompt and alerts when the model can't complete it.

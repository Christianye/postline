#!/usr/bin/env bash
# examples/daily-report/daily-report.sh
#
# Sample cron entry:
#   0 9 * * 1-5  cd $HOME/postline && bash examples/daily-report/daily-report.sh >> $HOME/postline-daily.log 2>&1
#
# Prerequisites:
#   - examples/daily-report/postline.config.ts lives at the repo root as
#     postline.config.ts (or set POSTLINE_CONFIG to its absolute path below)
#   - ANTHROPIC_API_KEY + POSTLINE_FEISHU_APP_SECRET exported
#   - gh CLI authenticated on this host (`gh auth status` works)
#   - the target chat_id added to feishu.sendAllowlist in the config

set -euo pipefail

# Point ask at the example config without clobbering any real config at the root.
export POSTLINE_CONFIG="${POSTLINE_CONFIG:-$PWD/examples/daily-report/postline.config.ts}"

# Customise the prompt below. This one asks for a 24h GitHub activity digest
# posted to the allowlisted feishu group. Replace org/repo + chat_id with yours.
PROMPT=$(cat <<'EOF'
Write a daily update for our team. Do exactly this:

1. Use gh_query to list PRs merged on Christianye/postline in the last 24h.
2. Use gh_query to list issues opened or commented in the last 24h.
3. Compose a 6-10 line summary in Chinese, grouped by "merged" / "open issues".
   No hype, no emoji, keep it factual.
4. Call feishu_send with chat_id=oc_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx (replace
   with your status group) and the summary as text.
5. Reply with a single line confirming what you sent.
EOF
)

# `pnpm build` produces packages/cli/dist/bin.js. We invoke node directly so
# this script can live under cron with a predictable PATH.
pnpm -r build >/dev/null
node packages/cli/dist/bin.js ask --user ou_daily_report "$PROMPT"

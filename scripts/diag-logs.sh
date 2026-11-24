#!/usr/bin/env bash
# Read a team phone's diagnostic log (docs/DIAGNOSTICS.md).
#   scripts/diag-logs.sh <code or link> [since] [session]
#   scripts/diag-logs.sh 3f9c…e1 2h                 the last two hours, one line an event
#   scripts/diag-logs.sh 3f9c…e1 1d <sessionId>     one placement test
#   FORMAT=json scripts/diag-logs.sh 3f9c…e1 30m    the same as JSON
# The server: ADAM_SERVER (default: the live one).
set -euo pipefail
arg="${1:?the diagnostics code or link (Account → Copy diagnostics link in the app)}"
since="${2:-1d}"; session="${3:-}"
server="${ADAM_SERVER:-https://adam-nfgw4g4xwa-el.a.run.app}"
if [[ "$arg" == http* ]]; then url="${arg%%\?*}"; else url="$server/api/diag/logs/$arg"; fi
q="since=$since&format=${FORMAT:-text}&limit=${LIMIT:-5000}"
[[ -n "$session" ]] && q="$q&session=$session"
curl -fsS "$url?$q"

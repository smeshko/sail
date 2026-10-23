#!/usr/bin/env bash
# The done stage: moves the ticket to done through `sail port ticket-source update`, then comments the merge on it, each
# tried three times a second apart, since the pull request is already merged and a failed step can't undo that. Its last
# stdout line is the ticket and the state it moved to.
set -euo pipefail

# Runs its arguments, after the file that is their stdin, up to three times a second apart: each try reads the file
# afresh. It gives the last exit code when all three failed.
retry() {
  local input=$1 tries=1 failed
  shift
  until "$@" <"$input" >/dev/null; do
    failed=$?
    if [ "$tries" -ge 3 ]; then return "$failed"; fi
    tries=$((tries + 1))
    sleep 1
  done
}

ticket=$(cat "$INPUT_TICKETKEY")
bun="${SAIL_BUN:-bun}"
tries=1
until moved=$(sail port ticket-source update "$ticket" --state done); do
  failed=$?
  if [ "$tries" -ge 3 ]; then exit "$failed"; fi
  tries=$((tries + 1))
  sleep 1
done
body=$(mktemp)
printf 'sail run %s merged %s as %s' "$RUN_ID" "$(cat "$INPUT_URL")" "$(cat "$INPUT_SHA")" >"$body"
retry "$body" sail port ticket-source comment "$ticket"
rm -f "$body"
printf '%s' "$moved" | TICKET="$ticket" "$bun" -e \
  'console.log(JSON.stringify({ ticketKey: process.env.TICKET, state: JSON.parse(await Bun.stdin.text()).state }))'

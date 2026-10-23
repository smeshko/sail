#!/usr/bin/env bash
# The publish stage: writes chain/<ticket>.md, commits it, pushes HEAD as the run's branch, $BRANCH, and opens the pull
# request into main, labelled sail, through `sail port codehost`. It then comments the pull request's link on the ticket
# and moves the ticket to in review, through `sail port ticket-source`, each tried three times a second apart, since a
# failed step fails the run for good once its pull request is open.
#
# A test holds the run here, while it still holds the branch's lease: when $CHAIN_HOLD names a file that doesn't exist,
# the script waits for it, for at most a minute. Without the variable it ends at once. Its last stdout line is the pull
# request's number, URL and head sha.
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
mkdir -p chain
printf 'Opened by sail run %s.\n' "$RUN_ID" >"chain/$ticket.md"
git add chain
git -c user.name=sail -c user.email=sail@users.noreply.github.com commit -q -m "$ticket: chain"
sail port codehost push "$BRANCH" >/dev/null
body=$(mktemp)
printf 'Opens %s, for sail run %s.\n' "$ticket" "$RUN_ID" >"$body"
pr=$(sail port codehost open-pull-request --base main --head "$BRANCH" --title "$ticket: chain" --body-file "$body" \
  --ticket "$ticket" --label sail)
# SAIL_BUN is the Bun that runs the run: the script kind sets it for every script step.
url=$(printf '%s' "$pr" | "${SAIL_BUN:-bun}" -e 'console.log(JSON.parse(await Bun.stdin.text()).url)')
printf 'sail run %s opened %s' "$RUN_ID" "$url" >"$body"
retry "$body" sail port ticket-source comment "$ticket"
retry /dev/null sail port ticket-source update "$ticket" --state in-review
rm -f "$body"

if [ -n "${CHAIN_HOLD:-}" ]; then
  waited=0
  while [ ! -e "$CHAIN_HOLD" ] && [ "$waited" -lt 300 ]; do
    sleep 0.2
    waited=$((waited + 1))
  done
fi
printf '%s' "$pr" | "${SAIL_BUN:-bun}" -e \
  'const p = JSON.parse(await Bun.stdin.text()); console.log(JSON.stringify({ number: p.number, url: p.url, headSha: p.headSha }))'

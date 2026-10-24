#!/usr/bin/env bash
# The open stage: pushes HEAD as the run's branch, $BRANCH, and opens the pull request into staging, labelled factory,
# through `sail port codehost`. It then comments the pull request's link on the ticket, through `sail port
# ticket-source`. A comment that fails is tried again, three tries a second apart, since a failed step fails the run for
# good once its pull request is open; a third failure fails the step. Its last stdout line is the pull request as the
# code host gave it.
set -euo pipefail

ticket=$(cat "$INPUT_TICKETKEY")
branch="$BRANCH"
sail port codehost push "$branch" >/dev/null
pr=$(sail port codehost open-pull-request --base staging --head "$branch" --title "$(cat "$INPUT_TITLE")" \
  --body-file "$INPUT_BODY" --ticket "$ticket" --label factory)
# SAIL_BUN is the Bun that runs the run: the script kind sets it for every script step.
url=$(printf '%s' "$pr" | "${SAIL_BUN:-bun}" -e 'console.log(JSON.parse(await Bun.stdin.text()).url)')
tries=1
until printf 'sail run %s opened %s' "$RUN_ID" "$url" | sail port ticket-source comment "$ticket" >/dev/null; do
  failed=$?
  if [ "$tries" -ge 3 ]; then exit "$failed"; fi
  tries=$((tries + 1))
  sleep 1
done
printf '%s\n' "$pr"

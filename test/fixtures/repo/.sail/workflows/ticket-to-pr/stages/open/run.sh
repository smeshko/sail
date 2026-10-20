#!/usr/bin/env bash
# The open stage: pushes HEAD as the run's branch, $BRANCH, and opens the pull request into main, labelled sail, through
# `sail port codehost`. It then comments the pull request's link on the ticket, through `sail port ticket-source`, and a
# comment that fails fails the step. Its last stdout line is the pull request as the code host gave it.
set -euo pipefail

ticket=$(cat "$INPUT_TICKETKEY")
branch="$BRANCH"
sail port codehost push "$branch" >/dev/null
pr=$(sail port codehost open-pull-request --base main --head "$branch" --title "$(cat "$INPUT_TITLE")" \
  --body-file "$INPUT_BODY" --ticket "$ticket" --label sail)
# SAIL_BUN is the Bun that runs the run: the script kind sets it for every script step.
url=$(printf '%s' "$pr" | "${SAIL_BUN:-bun}" -e 'console.log(JSON.parse(await Bun.stdin.text()).url)')
printf 'sail run %s opened %s' "$RUN_ID" "$url" | sail port ticket-source comment "$ticket" >/dev/null
printf '%s\n' "$pr"

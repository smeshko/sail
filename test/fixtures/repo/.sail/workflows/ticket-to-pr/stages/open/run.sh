#!/usr/bin/env bash
# The open stage: pushes HEAD as the run's branch, $BRANCH, and opens the pull request into main, labelled sail, through
# `sail port codehost`. Its last stdout line is the pull request as the code host gave it.
set -euo pipefail

ticket=$(cat "$INPUT_TICKETKEY")
branch="$BRANCH"
sail port codehost push "$branch" >/dev/null
sail port codehost open-pull-request --base main --head "$branch" --title "$(cat "$INPUT_TITLE")" \
  --body-file "$INPUT_BODY" --ticket "$ticket" --label sail

#!/usr/bin/env bash
# The publish stage: writes landed/<ticket>.md, holding the run id, commits it, pushes HEAD as the run's branch, $BRANCH,
# and opens the pull request into main, labelled sail, through `sail port codehost`. Its last stdout line is the pull
# request's number, URL and head sha: the head the merge expects.
set -euo pipefail

ticket=$(cat "$INPUT_TICKETKEY")
mkdir -p landed
printf 'Landed by sail run %s.\n' "$RUN_ID" >"landed/$ticket.md"
git add landed
git -c user.name=sail -c user.email=sail@users.noreply.github.com commit -q -m "$ticket: land"
sail port codehost push "$BRANCH" >/dev/null
body=$(mktemp)
printf 'Lands %s, for sail run %s.\n' "$ticket" "$RUN_ID" >"$body"
pr=$(sail port codehost open-pull-request --base main --head "$BRANCH" --title "$ticket: land" --body-file "$body" \
  --ticket "$ticket" --label sail)
rm -f "$body"
# SAIL_BUN is the Bun that runs the run: the script kind sets it for every script step.
printf '%s' "$pr" | "${SAIL_BUN:-bun}" -e \
  'const p = JSON.parse(await Bun.stdin.text()); console.log(JSON.stringify({ number: p.number, url: p.url, headSha: p.headSha }))'

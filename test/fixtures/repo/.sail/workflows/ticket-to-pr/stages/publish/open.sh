#!/usr/bin/env bash
# The open step of publish: pushes HEAD as the run's branch, $BRANCH, and opens the pull request into main, labelled
# sail, through `sail port codehost`, with the title and the body describe left. It then comments the pull request's
# link on the ticket, through `sail port ticket-source`. A comment that fails is tried again, three tries a second
# apart, since a failed step fails the run for good once its pull request is open; a third failure fails the step. Its
# last stdout line is the pull request as the code host gave it. A pull request needs a commit beyond its base, so when
# the run made none the step first makes one empty commit, with a fixed author and date so that a rerun pushes the same sha.
set -euo pipefail

ticket=$(cat "$INPUT_TICKETKEY")
branch="$BRANCH"
base=$(git rev-parse --verify --quiet origin/main || git rev-parse --verify --quiet main || true)
if [ -z "$base" ] || git merge-base --is-ancestor HEAD "$base"; then
  export GIT_AUTHOR_NAME=sail GIT_AUTHOR_EMAIL=sail@example.invalid GIT_AUTHOR_DATE=2026-01-01T00:00:00Z
  export GIT_COMMITTER_NAME=sail GIT_COMMITTER_EMAIL=sail@example.invalid GIT_COMMITTER_DATE=2026-01-01T00:00:00Z
  git commit --allow-empty --no-verify --no-gpg-sign -q -m 'chore: open the pull request with one commit, as the run made none'
fi
sail port codehost push "$branch" >/dev/null
pr=$(sail port codehost open-pull-request --base main --head "$branch" --title "$(cat "$INPUT_TITLE")" \
  --body-file "$INPUT_BODY" --ticket "$ticket" --label sail)
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

#!/usr/bin/env bash
# The open stage: pushes HEAD as the run's branch, $BRANCH, and opens the pull request into staging, labelled factory,
# through `sail port codehost`. It then comments the pull request's link on the ticket and moves the ticket to in
# review, through `sail port ticket-source`. Each ticket change is tried three times, a second apart. A third failure
# does not fail the step, since the pull request is already open and a failed run cannot be resumed: it is reported,
# with the `sail port` command that backfills it, on stderr and in the output. Its last stdout line is the pull
# request as the code host gave it, plus `ticket`: whether the comment and the move took, and the backfill commands.
set -euo pipefail

# Runs its arguments up to three times, a second apart.
retry() {
  local tries=1 failed
  until "$@" </dev/null >/dev/null; do
    failed=$?
    if [ "$tries" -ge 3 ]; then return "$failed"; fi
    tries=$((tries + 1))
    sleep 1
  done
}

ticket=$(cat "$INPUT_TICKETKEY")
branch="$BRANCH"
sail port codehost push "$branch" >/dev/null
pr=$(sail port codehost open-pull-request --base staging --head "$branch" --title "$(cat "$INPUT_TITLE")" \
  --body-file "$INPUT_BODY" --ticket "$ticket" --label factory)
# SAIL_BUN is the Bun that runs the run: the script kind sets it for every script step.
url=$(printf '%s' "$pr" | "${SAIL_BUN:-bun}" -e 'console.log(JSON.parse(await Bun.stdin.text()).url)')
# The comment body outlives the step in its stage output, so a backfill command can name it from any directory.
comment="$(cd "$STAGE_OUT" && pwd)/comment.md"
printf 'sail run %s opened %s' "$RUN_ID" "$url" > "$comment"
commented=true
moved=true
backfill=()
if ! retry sail port ticket-source comment "$ticket" --body-file "$comment"; then
  commented=false
  command="sail port ticket-source comment $ticket --body-file '$comment'"
  backfill+=("$command")
  printf 'the ticket comment failed; backfill it with: %s\n' "$command" >&2
fi
if ! retry sail port ticket-source update "$ticket" --state in-review; then
  moved=false
  command="sail port ticket-source update $ticket --state in-review"
  backfill+=("$command")
  printf 'the move to in review failed; backfill it with: %s\n' "$command" >&2
fi
PR="$pr" COMMENTED="$commented" MOVED="$moved" "${SAIL_BUN:-bun}" -e '
const [commented, moved] = [process.env.COMMENTED === "true", process.env.MOVED === "true"];
console.log(JSON.stringify({ ...JSON.parse(process.env.PR), ticket: { commented, moved, backfill: process.argv.slice(1) } }));
' "${backfill[@]+"${backfill[@]}"}"

#!/usr/bin/env bash
# The hand-back stage: comments on the pull request with the reason and the details, removes the label sail, then adds
# sail-blocked, so a poll between the two calls can't list the pull request. With a ticket it comments there too, and
# leaves the ticket's state alone. The details hold agent-written text: they go into a fenced block, longer than any
# run of backticks they hold, through --body-file, and nothing of them is evaluated. Its last stdout line is the labels
# after the swap.
set -euo pipefail

pr=$(cat "$INPUT_PR")
reason=$(cat "$INPUT_REASON")
body=$(mktemp)
# The longest run of backticks in the details, so the fence can be one longer (at least three).
longest=$(awk '{ s = $0; while (match(s, /`+/)) { if (RLENGTH > m) m = RLENGTH; s = substr(s, RSTART + RLENGTH) } } END { print m + 0 }' "$INPUT_DETAILS")
fence=$(printf '%*s' "$((longest < 3 ? 3 : longest + 1))" '' | tr ' ' '`')
{
  printf 'sail run %s handed this pull request back: %s\n\n' "$RUN_ID" "$reason"
  printf '%s\n' "$fence"
  cat "$INPUT_DETAILS"
  printf '\n%s\n' "$fence"
} >"$body"
sail port codehost comment "$pr" --body-file "$body" >/dev/null
sail port codehost remove-label "$pr" sail >/dev/null
labelled=$(sail port codehost add-label "$pr" sail-blocked)
if [ -n "${INPUT_TICKETKEY:-}" ]; then
  printf 'sail run %s handed pull request %s back: %s' "$RUN_ID" "$pr" "$reason" >"$body"
  sail port ticket-source comment "$(cat "$INPUT_TICKETKEY")" <"$body" >/dev/null
fi
rm -f "$body"
printf '%s' "$labelled" | "${SAIL_BUN:-bun}" -e \
  'const l = JSON.parse(await Bun.stdin.text()); console.log(JSON.stringify({ number: l.number, labels: l.labels }))'

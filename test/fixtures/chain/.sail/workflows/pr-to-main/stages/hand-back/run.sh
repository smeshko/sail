#!/usr/bin/env bash
# The hand-back stage: first reads the pull request, since a person may have taken it during the run. With the label sail
# gone it does what the stop stage does, a comment on the pull request and one on the ticket saying the run didn't
# merge, and changes no label. Otherwise it comments on the pull request with the reason and the details, removes the
# label sail, then adds sail-blocked, so a poll between the two calls can't list the pull request; a read that failed
# counts as labelled, so the swap still happens. With a ticket it comments there too, and leaves the ticket's state
# alone. The details hold agent-written text: they go into a fenced block, longer than any run of backticks they hold,
# through --body-file, cut to 60,000 bytes, with any run of four or more backticks cut to three so the fence stays four
# long, which keeps the whole comment under the host's limit; nothing of them is evaluated. Its last stdout line is the labels after the swap, and whether the label was still there.
set -euo pipefail

pr=$(cat "$INPUT_PR")
reason=$(cat "$INPUT_REASON")
bun="${SAIL_BUN:-bun}"
body=$(mktemp)
details=$(mktemp)
labels=$(sail port codehost get-pull-request "$pr" | "$bun" -e \
  'console.log(JSON.stringify(JSON.parse(await Bun.stdin.text()).labels))') || labels='["sail"]'
if [ "$(printf '%s' "$labels" | "$bun" -e 'console.log(JSON.parse(await Bun.stdin.text()).includes("sail"))')" != true ]; then
  printf 'sail run %s did not merge: the label sail was removed' "$RUN_ID" >"$body"
  sail port codehost comment "$pr" --body-file "$body" >/dev/null
  if [ -n "${INPUT_TICKETKEY:-}" ]; then
    sail port ticket-source comment "$(cat "$INPUT_TICKETKEY")" <"$body" >/dev/null
  fi
  rm -f "$body" "$details"
  printf '{"number":%s,"labels":%s,"labelled":false}\n' "$pr" "$labels"
  exit 0
fi
head -c 60000 "$INPUT_DETAILS" | LC_ALL=C sed -E 's/`{4,}/```/g' >"$details"
# The longest run of backticks in the details, so the fence can be one longer (at least three).
longest=$(awk '{ s = $0; while (match(s, /`+/)) { if (RLENGTH > m) m = RLENGTH; s = substr(s, RSTART + RLENGTH) } } END { print m + 0 }' "$details")
fence=$(printf '%*s' "$((longest < 3 ? 3 : longest + 1))" '' | tr ' ' '`')
{
  printf 'sail run %s handed this pull request back: %s\n\n' "$RUN_ID" "$reason"
  printf '%s\n' "$fence"
  cat "$details"
  printf '\n%s\n' "$fence"
  if [ "$(wc -c <"$INPUT_DETAILS")" -gt 60000 ]; then printf '\n(the details are cut at 60,000 bytes)\n'; fi
} >"$body"
sail port codehost comment "$pr" --body-file "$body" >/dev/null
sail port codehost remove-label "$pr" sail >/dev/null
labelled=$(sail port codehost add-label "$pr" sail-blocked)
if [ -n "${INPUT_TICKETKEY:-}" ]; then
  printf 'sail run %s handed pull request %s back: %s' "$RUN_ID" "$pr" "$reason" >"$body"
  sail port ticket-source comment "$(cat "$INPUT_TICKETKEY")" <"$body" >/dev/null
fi
rm -f "$body" "$details"
printf '%s' "$labelled" | "$bun" -e \
  'const l = JSON.parse(await Bun.stdin.text()); console.log(JSON.stringify({ number: l.number, labels: l.labels, labelled: true }))'

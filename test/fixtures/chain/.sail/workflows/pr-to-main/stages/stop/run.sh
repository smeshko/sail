#!/usr/bin/env bash
# The stop stage: one comment on the pull request, and one on its ticket when there is one, saying the run saw the label
# sail removed and didn't merge. It adds no sail-blocked: a person took the pull request, and the swap would only add
# noise. Its last stdout line is `{ number }`.
set -euo pipefail

pr=$(cat "$INPUT_PR")
body=$(mktemp)
printf 'sail run %s did not merge: the label sail was removed' "$RUN_ID" >"$body"
sail port codehost comment "$pr" --body-file "$body" >/dev/null
if [ -n "${INPUT_TICKETKEY:-}" ]; then
  sail port ticket-source comment "$(cat "$INPUT_TICKETKEY")" <"$body" >/dev/null
fi
rm -f "$body"
printf '{"number":%s}\n' "$pr"

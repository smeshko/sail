#!/usr/bin/env bash
# The hand-over stage: moves the ticket to in review through `sail port ticket-source update`, then comments the pull
# request's URL on it. Its last stdout line is the move as the ticket source gave it.
set -euo pipefail

ticket=$(cat "$INPUT_TICKETKEY")
moved=$(sail port ticket-source update "$ticket" --state in-review)
printf 'sail run %s landing %s' "$RUN_ID" "$(cat "$INPUT_URL")" | sail port ticket-source comment "$ticket" >/dev/null
printf '%s\n' "$moved"

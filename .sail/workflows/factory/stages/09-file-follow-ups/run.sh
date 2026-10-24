#!/usr/bin/env bash
# The file-follow-ups stage: files each follow-up as a ticket, then comments the tickets on the pull request.
set -euo pipefail
exec "${SAIL_BUN:-bun}" "$(dirname "$0")/file.mjs"

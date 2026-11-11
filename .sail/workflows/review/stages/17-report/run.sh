#!/usr/bin/env bash
# The report stage: writes REVIEW.md (the full report) and COMMENT.md (it, shortened to fit) and comments the latter on the pull request.
set -euo pipefail
exec "${SAIL_BUN:-bun}" "$(dirname "$0")/report.mjs"

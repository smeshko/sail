#!/usr/bin/env bash
# The report stage: writes REVIEW.md and comments it on the pull request.
set -euo pipefail
exec "${SAIL_BUN:-bun}" "$(dirname "$0")/report.mjs"

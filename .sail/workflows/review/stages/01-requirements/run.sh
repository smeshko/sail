#!/usr/bin/env bash
# The requirements stage: writes requirements.md from the pull request's ticket, or says it has none.
set -euo pipefail
exec "${SAIL_BUN:-bun}" "$(dirname "$0")/requirements.mjs"

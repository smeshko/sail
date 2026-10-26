#!/usr/bin/env bash
# The merge stage. Exits 0 once the pull request is merged, 1 when it can't be.
set -euo pipefail
exec "${SAIL_BUN:-bun}" "$(dirname "$0")/merge.mjs"

#!/usr/bin/env bash
# The sync-base stage: merges the pull request's current base into the branch. Exits 0 with what it did, conflicts
# included.
set -euo pipefail
exec "${SAIL_BUN:-bun}" "$(dirname "$0")/sync.mjs"

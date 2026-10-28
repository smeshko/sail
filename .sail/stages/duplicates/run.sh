#!/usr/bin/env bash
# The duplicates stage: asks Jev whether the ticket and each other open ticket describe the same work.
set -euo pipefail
exec "${SAIL_BUN:-bun}" "$(dirname "$0")/duplicates.mjs"

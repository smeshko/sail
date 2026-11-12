#!/usr/bin/env bash
# The duplicates stage: ranks the other open tickets by how likely each is the same work as the groomed one.
set -euo pipefail
exec "${SAIL_BUN:-bun}" "$(dirname "$0")/duplicates.mjs"

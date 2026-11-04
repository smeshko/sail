#!/usr/bin/env bash
# The load-plan stage: downloads the ticket's files and leaves the plan attached last as plan.md.
set -euo pipefail
exec "${SAIL_BUN:-bun}" "$(dirname "$0")/load.mjs"

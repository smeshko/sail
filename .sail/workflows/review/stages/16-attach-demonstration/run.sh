#!/usr/bin/env bash
# The attach-demonstration stage: attaches the demonstration's files to the ticket, and comments its criteria.
set -euo pipefail
exec "${SAIL_BUN:-bun}" "$(dirname "$0")/attach.mjs"

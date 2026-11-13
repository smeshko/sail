#!/usr/bin/env bash
# The rulings stage: asks Jev whether the ticket's rulings answer each earlier open question, and prints its Ruled.
set -euo pipefail
exec "${SAIL_BUN:-bun}" "$(dirname "$0")/rulings.mjs"

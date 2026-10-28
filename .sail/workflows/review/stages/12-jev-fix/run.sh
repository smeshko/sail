#!/usr/bin/env bash
# The jev-fix stage: asks Jev whether each finding the fixes target is resolved, and prints its FixAsked.
set -euo pipefail
exec "${SAIL_BUN:-bun}" "$(dirname "$0")/fix.mjs"

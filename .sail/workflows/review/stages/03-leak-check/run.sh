#!/usr/bin/env bash
# The leak-check stage: scans the added lines of $INPUT_DIFF. Exits 0 whatever it finds: its hits are its output.
set -euo pipefail
exec "${SAIL_BUN:-bun}" "$(dirname "$0")/leaks.mjs"

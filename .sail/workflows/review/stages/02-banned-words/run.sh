#!/usr/bin/env bash
# Scan added lines for avoided words and ask Jev about their sense.
set -euo pipefail
exec "${SAIL_BUN:-bun}" "$(dirname "$0")/banned.mjs"

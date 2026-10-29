#!/usr/bin/env bash
# Scan added lines and commit messages for avoided words and ask Jev about their sense.
set -euo pipefail
exec "${SAIL_BUN:-bun}" "$(dirname "$0")/banned.mjs"

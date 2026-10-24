#!/usr/bin/env bash
# The demo harness: a scratch repository on fake ports where a stage runs this checkout's sail the way a user would.
# See demo.mjs for the commands.
set -uo pipefail
exec "${SAIL_BUN:-bun}" "$(dirname "$0")/demo.mjs" "$@"

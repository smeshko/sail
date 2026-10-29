#!/usr/bin/env bash
# The hand-over stage: comments why the review stopped, swaps the designation label for needs-human.
set -euo pipefail
exec "${SAIL_BUN:-bun}" "$(dirname "$0")/hand-over.mjs"

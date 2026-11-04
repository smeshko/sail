#!/usr/bin/env bash
# The hand-over-ticket stage: comments why the run stopped, swaps the designation label for needs-human.
set -euo pipefail
exec "${SAIL_BUN:-bun}" "$(dirname "$0")/hand-over.mjs"

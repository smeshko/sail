#!/usr/bin/env bash
# The overlap stage: names the open planned ticket whose plan changes a file the new plan changes, for the ticket to
# wait on.
set -euo pipefail
exec "${SAIL_BUN:-bun}" "$(dirname "$0")/overlap.mjs"

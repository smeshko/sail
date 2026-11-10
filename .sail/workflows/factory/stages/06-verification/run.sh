#!/usr/bin/env bash
# The verification stage: adds the evidence of the tasks that changed no file to the pull request's body.
set -euo pipefail
exec "${SAIL_BUN:-bun}" "$(dirname "$0")/verification.mjs"

#!/usr/bin/env bash
# The prove-tests stage. Exits 0 when the pending tests are proven, 1 with the problems when not.
set -uo pipefail
. "$(dirname "${SAIL_CONFIG:?}")/lib/play.sh"
exec "${SAIL_BUN:-bun}" "$(dirname "$0")/prove.mjs"

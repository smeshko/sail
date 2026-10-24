#!/usr/bin/env bash
# The validate stage. Exits 0 when the branch is ready, 1 with what isn't.
set -uo pipefail
. "$(dirname "${SAIL_CONFIG:?}")/lib/play.sh"
exec "${SAIL_BUN:-bun}" "$(dirname "$0")/validate.mjs"

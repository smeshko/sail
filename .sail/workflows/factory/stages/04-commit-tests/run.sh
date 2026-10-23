#!/usr/bin/env bash
# The commit-tests stage. Its last stdout line is the two commits' shas.
set -euo pipefail
. "$(dirname "${SAIL_CONFIG:?}")/lib/play.sh"
exec "${SAIL_BUN:-bun}" "$(dirname "$0")/commit.mjs"

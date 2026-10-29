#!/usr/bin/env bash
# The jev-tasks stage: asks Jev whether each task of the plan is implemented, and prints its TasksAsked.
set -euo pipefail
exec "${SAIL_BUN:-bun}" "$(dirname "$0")/tasks.mjs"

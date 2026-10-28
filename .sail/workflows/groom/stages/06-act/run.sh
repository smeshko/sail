#!/usr/bin/env bash
# The act stage: applies the judge's actions, comments the report on the ticket and removes the designation label.
set -euo pipefail
exec "${SAIL_BUN:-bun}" "$(dirname "$0")/act.mjs"

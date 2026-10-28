#!/usr/bin/env bash
# The act stage: applies the judge's actions, comments the report on the ticket and swaps the designation label for groomed
# or open-questions.
set -euo pipefail
exec "${SAIL_BUN:-bun}" "$(dirname "$0")/act.mjs"

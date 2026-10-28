#!/usr/bin/env bash
# groom's intake step: reads the ticket and the team's other open tickets, and writes the brief and the others.
set -euo pipefail
exec "${SAIL_BUN:-bun}" "$(dirname "$0")/read.mjs"

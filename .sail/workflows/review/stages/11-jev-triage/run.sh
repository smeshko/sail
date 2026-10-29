#!/usr/bin/env bash
set -euo pipefail
exec "${SAIL_BUN:-bun}" "$(dirname "$0")/triage.mjs"

#!/usr/bin/env bash
# The record-review stage: pure formatting, so it runs on the fake workspace too.
set -euo pipefail
exec "${SAIL_BUN:-bun}" "$(dirname "$0")/record.mjs"

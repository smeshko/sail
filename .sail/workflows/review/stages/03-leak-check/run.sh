#!/usr/bin/env bash
# The leak-check stage scans added lines and asks Jev about comments, docs and commit messages. Its hits are its output.
set -euo pipefail
exec "${SAIL_BUN:-bun}" "$(dirname "$0")/leaks.mjs"

#!/bin/sh
exec "${SAIL_BUN:-bun}" "$(dirname "$0")/gate-files.mjs"

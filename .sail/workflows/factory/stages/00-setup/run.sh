#!/usr/bin/env bash
# The setup stage: `bun install` from the lockfile. Its log goes to stderr, and its last stdout line is the report.
set -uo pipefail
. "$(dirname "${SAIL_CONFIG:?}")/lib/play.sh"

bun="${SAIL_BUN:-bun}"
log="${STAGE_OUT:?}/install.log"
"$bun" install --frozen-lockfile >"$log" 2>&1
code=$?
cat "$log" >&2
LOG="$log" CODE="$code" "$bun" -e '
const { readFileSync } = require("node:fs");
const tail = readFileSync(process.env.LOG, "utf8").split("\n").slice(-20).join("\n");
console.log(JSON.stringify({ ok: process.env.CODE === "0", tail }));'
exit "$code"

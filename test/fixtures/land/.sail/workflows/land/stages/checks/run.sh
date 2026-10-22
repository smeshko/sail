#!/usr/bin/env bash
# The checks stage: reads the pull request's checks through `sail port codehost checks`, up to $INPUT_TRIES times,
# $INPUT_INTERVALSECONDS apart, while any is pending. The verdict is failed if any check failed, pending if any still
# is, and passed otherwise. Its last stdout line is the verdict with the checks of the last read.
set -euo pipefail

pr=$(cat "$INPUT_PR")
tries=$(cat "$INPUT_TRIES")
try=1
while :; do
  read=$(sail port codehost checks "$pr")
  verdict=$(printf '%s' "$read" | "${SAIL_BUN:-bun}" -e \
    'const { checks } = JSON.parse(await Bun.stdin.text()); const is = (s) => checks.some((c) => c.status === s); console.log(is("failed") ? "failed" : is("pending") ? "pending" : "passed")')
  if [ "$verdict" != pending ] || [ "$try" -ge "$tries" ]; then break; fi
  try=$((try + 1))
  sleep "$(cat "$INPUT_INTERVALSECONDS")"
done
printf '%s' "$read" | VERDICT="$verdict" "${SAIL_BUN:-bun}" -e \
  'const { checks } = JSON.parse(await Bun.stdin.text()); console.log(JSON.stringify({ verdict: process.env.VERDICT, checks: checks.map(({ name, status }) => ({ name, status })) }))'

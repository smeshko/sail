#!/usr/bin/env bash
# The checks stage. Each try reads the pull request's checks through `sail port codehost checks`, which answers with the
# head it read them at, and stops at the first verdict that isn't pending or after $INPUT_TRIES tries,
# $INPUT_INTERVALSECONDS apart. A read of another head than $INPUT_HEADSHA (the host lags a push) or a read that failed
# saw nothing yet: that try is pending, and the next one reads again. The verdict is failed if any check failed, passed
# once every name in $INPUT_REQUIRED has passed and none is pending, and pending otherwise: no checks at all is pending,
# and a required check that was skipped never passes. Its last stdout line is the verdict with the checks of the last
# read.
set -euo pipefail

pr=$(cat "$INPUT_PR")
tries=$(cat "$INPUT_TRIES")
bun="${SAIL_BUN:-bun}"
try=1
while :; do
  answer=$(sail port codehost checks "$pr") || answer='{}'
  read=$(printf '%s' "$answer" | SHA="$(cat "$INPUT_HEADSHA")" REQUIRED="$INPUT_REQUIRED" "$bun" -e '
    const answer = JSON.parse(await Bun.stdin.text());
    const required = JSON.parse(await Bun.file(process.env.REQUIRED).text());
    const checks =
      answer.headSha === process.env.SHA && Array.isArray(answer.checks)
        ? answer.checks.map(({ name, status }) => ({ name, status }))
        : [];
    const is = (status) => checks.some((check) => check.status === status);
    const passed = required.every((name) => checks.some((check) => check.name === name && check.status === "passed"));
    console.log(JSON.stringify({ verdict: is("failed") ? "failed" : passed && !is("pending") ? "passed" : "pending", checks }));
  ')
  case "$read" in
    '{"verdict":"pending"'*) ;;
    *) break ;;
  esac
  if [ "$try" -ge "$tries" ]; then break; fi
  try=$((try + 1))
  sleep "$(cat "$INPUT_INTERVALSECONDS")"
done
printf '%s\n' "$read"

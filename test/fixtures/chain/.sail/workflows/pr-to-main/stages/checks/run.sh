#!/usr/bin/env bash
# The checks stage. Each try reads the pull request until its head is $INPUT_HEADSHA, since a host lags a push, then its
# checks through `sail port codehost checks`, and stops at the first verdict that isn't pending or after $INPUT_TRIES
# tries, $INPUT_INTERVALSECONDS apart. The verdict is failed if any check failed, passed once every name in
# $INPUT_REQUIRED is there and none is pending, and pending otherwise: no checks at all is pending. Its last stdout
# line is the verdict with the checks of the last read.
set -euo pipefail

pr=$(cat "$INPUT_PR")
sha=$(cat "$INPUT_HEADSHA")
tries=$(cat "$INPUT_TRIES")
bun="${SAIL_BUN:-bun}"
try=1
checks='{"checks":[]}'
while :; do
  head=$(sail port codehost get-pull-request "$pr" | "$bun" -e 'console.log(JSON.parse(await Bun.stdin.text()).headSha)')
  if [ "$head" = "$sha" ]; then
    checks=$(sail port codehost checks "$pr")
    verdict=$(printf '%s' "$checks" | REQUIRED="$INPUT_REQUIRED" "$bun" -e '
      const { checks } = JSON.parse(await Bun.stdin.text());
      const required = JSON.parse(await Bun.file(process.env.REQUIRED).text());
      const is = (status) => checks.some((check) => check.status === status);
      const present = required.every((name) => checks.some((check) => check.name === name));
      console.log(is("failed") ? "failed" : present && !is("pending") ? "passed" : "pending");
    ')
  else
    checks='{"checks":[]}'
    verdict=pending
  fi
  if [ "$verdict" != pending ] || [ "$try" -ge "$tries" ]; then break; fi
  try=$((try + 1))
  sleep "$(cat "$INPUT_INTERVALSECONDS")"
done
printf '%s' "$checks" | VERDICT="$verdict" "$bun" -e \
  'const { checks } = JSON.parse(await Bun.stdin.text()); console.log(JSON.stringify({ verdict: process.env.VERDICT, checks: checks.map(({ name, status }) => ({ name, status })) }))'

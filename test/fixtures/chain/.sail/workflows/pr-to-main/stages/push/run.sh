#!/usr/bin/env bash
# The push stage: pushes HEAD as the run's branch, $BRANCH, through `sail port codehost`, then reports the head sha it
# pushed. A branch with nothing new to push is up to date, not a failure. First it lists the files the commits since
# $INPUT_SINCE, the head before `fix` ran, change: `fix` may write only under src/ and test/, but a test it runs can write
# anywhere, so a commit that reaches past them, such as one to .github/, is never pushed. Such a push exits 1 with the
# files. Its last stdout line is `{ headSha }`, with `files` on a refusal.
set -euo pipefail

outside=$(git diff --name-only "$(cat "$INPUT_SINCE")" HEAD | grep -v -E '^(src|test)/' || true)
if [ -n "$outside" ]; then
  printf '%s' "$outside" | HEAD_SHA="$(git rev-parse HEAD)" "${SAIL_BUN:-bun}" -e \
    'const files = (await Bun.stdin.text()).split("\n").filter(Boolean); console.log(JSON.stringify({ headSha: process.env.HEAD_SHA, files }))'
  exit 1
fi
sail port codehost push "$BRANCH" >/dev/null
printf '{"headSha":"%s"}\n' "$(git rev-parse HEAD)"

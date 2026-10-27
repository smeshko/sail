#!/usr/bin/env bash
# The push stage: pushes HEAD to $BRANCH, the pull request's branch, through `sail port codehost`, unless HEAD is still
# the head the review began at. Its last stdout line is whether it pushed, and the head.
set -euo pipefail
since=$(cat "$INPUT_SINCE")
head=$(git rev-parse HEAD)
if [ "$head" = "$since" ]; then
  printf '{"pushed":false,"headSha":"%s"}\n' "$head"
  exit 0
fi
sail port codehost push "$BRANCH" >&2
printf '{"pushed":true,"headSha":"%s"}\n' "$head"

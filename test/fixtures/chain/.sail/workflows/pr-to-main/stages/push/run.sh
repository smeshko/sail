#!/usr/bin/env bash
# The push stage: pushes HEAD as the run's branch, $BRANCH, through `sail port codehost`, then reports the head sha it
# pushed. A branch with nothing new to push is up to date, not a failure. Its last stdout line is `{ headSha }`.
set -euo pipefail

sail port codehost push "$BRANCH" >/dev/null
printf '{"headSha":"%s"}\n' "$(git rev-parse HEAD)"

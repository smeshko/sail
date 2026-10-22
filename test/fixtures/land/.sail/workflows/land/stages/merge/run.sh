#!/usr/bin/env bash
# The merge stage: merges the pull request by squash through `sail port codehost merge`, naming the head publish
# opened it at, so a head that moved since is refused. A merge the host rejects exits 1, and fails the step. Its last
# stdout line is the merge result as the code host gave it.
set -euo pipefail

sail port codehost merge "$(cat "$INPUT_PR")" --method squash --expected-head-sha "$(cat "$INPUT_HEADSHA")"

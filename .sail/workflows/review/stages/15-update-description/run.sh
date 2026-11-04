#!/usr/bin/env bash
# The update-description stage: sets the pull request's body to the text the fix wrote, through `sail port codehost`.
# Its last stdout line is the body as the host now holds it.
set -euo pipefail
pr=$(cat "$INPUT_PR")
cp "$INPUT_BODY" "$STAGE_OUT/body.md"
answer=$(sail port codehost update-pull-request "$pr" --body-file "$STAGE_OUT/body.md" | tail -n 1)
printf '%s' "$answer" | bun -e 'console.log(JSON.stringify({ body: JSON.parse(await Bun.stdin.text()).body }))'

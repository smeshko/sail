#!/usr/bin/env bash
# The push stage: pushes HEAD as the run's branch, $BRANCH, through `sail port codehost`, then reports the head sha it
# pushed. A branch with nothing new to push is up to date, not a failure. First it lists the files the commits since
# $INPUT_SINCE, the head before `fix` ran, change: `fix` may write only under src/ and test/, but a test it runs can write
# anywhere, so a commit that reaches past them, such as one to .github/, is never pushed. Renames are listed as a
# deletion and an addition, so a file moved into src/ names the path it left, and a diff git can't make ends the step
# in error. Such a push exits 1 with the files. Its last stdout line is `{ headSha }`, with `files` on a refusal.
set -euo pipefail

changed=$(mktemp)
git diff --no-renames --name-only -z "$(cat "$INPUT_SINCE")" HEAD >"$changed"
refusal=$(HEAD_SHA="$(git rev-parse HEAD)" "${SAIL_BUN:-bun}" -e '
  const files = (await Bun.file(process.argv[1]).text()).split("\0").filter(Boolean);
  const outside = files.filter((file) => !file.startsWith("src/") && !file.startsWith("test/"));
  if (outside.length > 0) console.log(JSON.stringify({ headSha: process.env.HEAD_SHA, files: outside }));
' "$changed")
rm -f "$changed"
if [ -n "$refusal" ]; then
  printf '%s\n' "$refusal"
  exit 1
fi
sail port codehost push "$BRANCH" >/dev/null
printf '{"headSha":"%s"}\n' "$(git rev-parse HEAD)"

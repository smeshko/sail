#!/usr/bin/env bash
# The update stage: fetches main and, when it isn't an ancestor of HEAD, merges it in and pushes the result. A merge
# that conflicts is aborted, so the workspace holds no MERGE_HEAD, and exits 1 with the conflicting files. Its last
# stdout line is the state and the head sha the branch ends at.
set -euo pipefail

git fetch --no-tags origin main >/dev/null 2>&1
if git merge-base --is-ancestor origin/main HEAD; then
  printf '{"state":"up-to-date","headSha":"%s"}\n' "$(git rev-parse HEAD)"
  exit 0
fi
if git -c user.name=sail -c user.email=sail@users.noreply.github.com merge --no-edit origin/main >/dev/null 2>&1; then
  sail port codehost push "$BRANCH" >/dev/null
  printf '{"state":"merged","headSha":"%s"}\n' "$(git rev-parse HEAD)"
  exit 0
fi
files=$(git diff --name-only --diff-filter=U)
git merge --abort
printf '%s' "$files" | HEAD_SHA="$(git rev-parse HEAD)" "${SAIL_BUN:-bun}" -e \
  'const files = (await Bun.stdin.text()).split("\n").filter(Boolean); console.log(JSON.stringify({ state: "conflict", headSha: process.env.HEAD_SHA, files }))'
exit 1

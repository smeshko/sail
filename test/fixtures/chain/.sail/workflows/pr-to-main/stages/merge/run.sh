#!/usr/bin/env bash
# The merge stage: the last look, then the merge. It reads the pull request once more in this same step, so a label
# removed, a base changed or a head moved since the gate read it, or a run resumed after the gate, never merges: it
# fetches main too, which must still be an ancestor of the head the checks ran at, since another pull request may have
# merged meanwhile. Any of those prints a refusal and sends no merge request; `labelled: false` says the label is gone.
# Otherwise it merges by squash through `sail port codehost merge`, naming that head, so a head that moves in the moment
# between the two is refused by the host. From the fetch to the merge's answer it holds the clone's merge lock, a
# directory in the git dir every run's worktree shares, so two runs can't both pass the main check before either merges;
# it waits up to 120 s for it, takes over one left more than 10 minutes, and refuses when the wait runs out. A merge the
# host rejects exits 1 and ends the step in error. Its last stdout line is the merge result as the code host gave it, or
# the refusal.
set -euo pipefail

pr=$(cat "$INPUT_PR")
sha=$(cat "$INPUT_HEADSHA")
lock="$(git rev-parse --path-format=absolute --git-common-dir)/sail-merge.lock"
waited=0
until mkdir "$lock" 2>/dev/null; do
  if [ -n "$(find "$lock" -maxdepth 0 -mmin +10 2>/dev/null)" ]; then rmdir "$lock" 2>/dev/null || true; continue; fi
  if [ "$waited" -ge 120 ]; then
    printf '{"state":"refused","reason":"another run held the merge lock %s for 120 s","labelled":true}\n' "$lock"
    exit 0
  fi
  sleep 1
  waited=$((waited + 1))
done
trap 'rmdir "$lock"' EXIT
git fetch --no-tags origin main >/dev/null 2>&1
if git merge-base --is-ancestor origin/main "$sha"; then current=yes; else current=no; fi
refusal=$(sail port codehost get-pull-request "$pr" | SHA="$sha" CURRENT="$current" "${SAIL_BUN:-bun}" -e '
  const pr = JSON.parse(await Bun.stdin.text());
  const refuse = (reason, labelled = true) => console.log(JSON.stringify({ state: "refused", reason, labelled }));
  if (!pr.labels.includes("sail")) refuse("the designation label was removed", false);
  else if (pr.state !== "open") refuse(`the pull request is ${pr.state}`);
  else if (pr.base !== "main") refuse("the pull request is no longer based on main");
  else if (pr.headSha !== process.env.SHA) refuse(`its head moved to ${pr.headSha}`);
  else if (process.env.CURRENT !== "yes") refuse("main moved past the head the checks ran at");
')
if [ -n "$refusal" ]; then
  printf '%s\n' "$refusal"
  exit 0
fi
sail port codehost merge "$pr" --method squash --expected-head-sha "$sha"

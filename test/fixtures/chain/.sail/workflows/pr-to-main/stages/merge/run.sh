#!/usr/bin/env bash
# The merge stage: the last look, then the merge. It reads the pull request once more in this same step, so a label
# removed, a base changed or a head moved since the gate read it, or a run resumed after the gate, never merges: it
# fetches main too, which must still be an ancestor of the head the checks ran at, since another pull request may have
# merged meanwhile. Any of those prints a refusal and sends no merge request; `labelled: false` says the label is gone.
# Otherwise it merges by squash through `sail port codehost merge`, naming that head, so a head that moves in the moment
# between the two is refused by the host. From the fetch to the merge's answer it holds the clone's merge lock, an
# flock on a file in the git dir every run's worktree shares, so two runs can't both pass the main check before either
# merges. The lock belongs to this shell's open file, so it goes when the step ends, killed or not, and nothing is left
# to take over. It waits up to 120 s for it, and refuses when the wait runs out. A merge the host rejects exits 1 and
# ends the step in error, unless a re-read of the pull request finds it merged anyway: a merge answered pending, or
# whose call failed, such as a lost response, is read again, and one that merged is reported `merged` with its sha. Its
# last stdout line is the merge result as the code host gave it, the refusal, or, after a re-read that found it merged,
# a `merged` result of its own, with the merge commit's sha and a reason that says how.
set -euo pipefail

pr=$(cat "$INPUT_PR")
sha=$(cat "$INPUT_HEADSHA")
lock="$(git rev-parse --path-format=absolute --git-common-dir)/sail-merge.lock"
exec 9>>"$lock"
# perl takes the flock on fd 9, which this shell holds open: the lock outlives perl and goes with the shell. Every other
# command runs with fd 9 closed, so nothing it leaves running, a detached git gc say, keeps the lock.
if ! perl -MFcntl=:flock -e 'open(my $fd, ">&=", 9) or die; for (1 .. 120) { exit 0 if flock($fd, LOCK_EX | LOCK_NB); sleep 1 } exit 1'; then
  printf '{"state":"refused","reason":"another run held the merge lock %s for 120 s","labelled":true}\n' "$lock"
  exit 0
fi
git fetch --no-tags origin main >/dev/null 2>&1 9>&-
if git merge-base --is-ancestor origin/main "$sha" 9>&-; then current=yes; else current=no; fi
refusal=$(sail port codehost get-pull-request "$pr" 9>&- | SHA="$sha" CURRENT="$current" "${SAIL_BUN:-bun}" -e '
  const pr = JSON.parse(await Bun.stdin.text());
  const refuse = (reason, labelled = true) => console.log(JSON.stringify({ state: "refused", reason, labelled }));
  if (!pr.labels.includes("sail")) refuse("the designation label was removed", false);
  else if (pr.state !== "open") refuse(`the pull request is ${pr.state}`);
  else if (pr.base !== "main") refuse("the pull request is no longer based on main");
  else if (pr.headSha !== process.env.SHA) refuse(`its head moved to ${pr.headSha}`);
  else if (process.env.CURRENT !== "yes") refuse("main moved past the head the checks ran at");
' 9>&-)
if [ -n "$refusal" ]; then
  printf '%s\n' "$refusal"
  exit 0
fi
if answer=$(sail port codehost merge "$pr" --method squash --expected-head-sha "$sha" 9>&-); then sent=yes; else sent=no; fi
if [ "$sent" = yes ] && [ "$(printf '%s' "$answer" | "${SAIL_BUN:-bun}" -e 'console.log(JSON.parse(await Bun.stdin.text()).state)' 9>&-)" != pending ]; then
  printf '%s\n' "$answer"
  exit 0
fi
# The merge answered pending, or its call failed: the host may have merged all the same. Re-read the pull request, and
# when it merged, ask the port once more, which reports a merged pull request with its sha and sends no second request.
# Only a `merged` answer counts: one merged without its merge commit is answered pending, and falls through.
if reread=$(sail port codehost get-pull-request "$pr" 9>&-) \
  && [ "$(printf '%s' "$reread" | "${SAIL_BUN:-bun}" -e 'console.log(JSON.parse(await Bun.stdin.text()).state)' 9>&-)" = merged ] \
  && recovered=$(sail port codehost merge "$pr" --method squash --expected-head-sha "$sha" 9>&-) \
  && [ "$(printf '%s' "$recovered" | "${SAIL_BUN:-bun}" -e 'console.log(JSON.parse(await Bun.stdin.text()).state)' 9>&-)" = merged ]; then
  if [ "$sent" = yes ]; then how="the merge answered pending"; else how="the merge's answer was lost"; fi
  printf '%s' "$recovered" | HOW="$how" "${SAIL_BUN:-bun}" -e '
    const merged = JSON.parse(await Bun.stdin.text());
    console.log(JSON.stringify({ state: "merged", sha: merged.sha, reason: `${process.env.HOW}; a re-read found it merged` }));
  ' 9>&-
  exit 0
fi
if [ "$sent" = yes ]; then
  printf '%s\n' "$answer"
  exit 0
fi
exit 1

Fix this pull request's findings. A judge has read every finding of its review and decided these belong to it:
`$STAGE_IN/findings.json` holds them, each with its id, severity, file and detail. What the pull request should do is
at `{{requirements}}`, and its change so far is `git diff {{base}}...HEAD`.
{{#if feedback}}

## The last pass didn't hold

Your commits from earlier passes are on the branch. `$STAGE_IN/feedback.json` holds why that pass didn't stand:
under `open`, each finding a reviewer found still unresolved, with why; under `fresh`, problems the fixes themselves
introduced, numbered like the findings; and under `validation`, when it failed, paths left uncommitted and each failing
test with its error. Fix what it reports, in new commits: never amend or rewrite an earlier one.
{{/if}}

## Fix each finding, one commit each

For each, in order:

1. Write a regression test first, and run it to watch it fail on its assertion. Change no existing assertion unless
   the finding is that the assertion is wrong. A finding no test can observe (a name, a comment, a doc) needs none.
2. Make the change, the smallest that fixes it, and run the test to watch it pass.
3. Run the fix's test files by name, then `bun run typecheck` and `bun run lint`. Never run a folder, the whole suite
   or `bun run gate`: validation runs after you.
4. Stage only the files this fix touches, by name, and commit the test and the fix together with one single-quoted
   message: `git commit -m 'fix(<scope>): <what it fixes> (review <id>){{#if ticketKey}} ({{ticketKey}}){{/if}}'`, with
   the scope the pull request's own commits use. A message built with `$(…)` or a heredoc can't be checked, and is
   denied.

If a fix turns out deeper than the finding looked, or would widen the change past its requirements, leave it, make no
commit for it, and say why in its note. Don't fix what isn't listed.

Read files with the Read tool, or `sed -n` for a range. Change them only with Edit and Write: `sed -i`, `python3` and
a heredoc into a file are denied, and each denial costs a turn.

## Submit

Submit each finding you were given, and each in `fresh`, by its id, with its fix commit's sha, or null when you made
none, and a one-sentence note.

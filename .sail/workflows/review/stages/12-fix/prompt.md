Fix this pull request's findings. A judge has read every finding of its review and decided these belong to it:
`$STAGE_IN/findings.json` holds them, each with its id, severity, file and detail. What the pull request should do is
at `{{requirements}}`, and its change so far is `git diff {{base}}...HEAD`.

A finding from `checks` is a check that failed on the pushed pull request after a rerun: its detail is the tail of the
check's log. Find the failing test or step in it, reproduce it by running that test file by name, and fix the cause.
A test that fails only on timing is still yours to make deterministic.
{{#if feedback}}

## The last pass didn't hold

Your commits from earlier passes are on the branch. `$STAGE_IN/feedback.json` holds why that pass didn't stand:
under `open`, each finding a reviewer found still unresolved, with why; under `fresh`, problems the fixes themselves
introduced, numbered like the findings; and under `validation`, when it failed, paths left uncommitted and each failing
test with its error. Fix what it reports, in new commits: never amend or rewrite an earlier one.
{{/if}}

## Fix each finding: a bug in a commit of its own, the minor ones together

A finding a test can observe gets a commit of its own. A `low` finding no test can observe (a name, a comment, a
header, a help line, a doc) goes with the others like it into one last commit, `fix(<scope>): review nits (review <id>,
<id>…)`, after the rest. One wording finding is still that one commit.

For each finding a test can observe, in order:

1. Write a regression test first, and run it to watch it fail on its assertion. Change no existing assertion unless
   the finding is that the assertion is wrong. A finding no test can observe (a name, a comment, a doc) needs none.
2. Make the change, the smallest that fixes it, and run the test to watch it pass.
3. Run the fix's test files by name, then `bun run typecheck` and `bun run lint`. Never run a folder, the whole suite
   or `bun run gate`: validation runs after you.
4. Stage only the files this fix touches, by name, and commit the test and the fix together:
   `git commit -m 'fix(<scope>): <what it fixes> (review <id>){{#if ticketKey}} ({{ticketKey}}){{/if}}'`, with the
   scope the pull request's own commits use.

If a fix turns out deeper than the finding looked, or would widen the change past its requirements, leave it, make no
commit for it, and say why in its note. Don't fix what isn't listed.

Read files with the Read tool, or `sed -n` for a range, and change them with Edit and Write.

Write a scratch file, if you need one, under `$STAGE_OUT`, never in the repository: `rm` and `git clean` are
denied, so a file left there can't be removed, and validation fails while any path is uncommitted. Pushing, `gh` and
network clients are denied too: the review's push stage pushes your commits.

## Submit

Submit each finding you were given, and each in `fresh`, by its id, with its fix commit's sha (the nits share theirs),
or null when you made none, and a one-sentence note.

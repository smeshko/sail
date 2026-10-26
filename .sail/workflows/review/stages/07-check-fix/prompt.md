Review the fixes made to this pull request since its review began: `git log {{since}}..HEAD` and
`git diff {{since}}..HEAD`. `$STAGE_IN/findings.json` holds every finding the fixes target, and
`$STAGE_IN/fixed.json` what the last fix pass says it did for each: its commit, or why it made none.

You review only. Don't change any file. Validation runs the tests beside you.

## For each finding

Read the finding, then the code as it is now. It is resolved when the problem it describes is gone: its trigger no
longer goes wrong, and, where a test can observe it, a test fails without the fix. A commit that only touches the
symptom, a test that would pass with the bug back, or no commit at all, leaves it unresolved. Say why in its detail.

## What the fixes broke

Report as findings the problems the fixes themselves introduced: a regression, a broken contract, a test weakened to
pass. Only what you can point at, with its severity: `high` for one that ships broken behaviour, `medium` for a narrow
trigger, `low` for the rest. Don't report again what the findings already hold, nor problems older than the fixes.

## Submit

Submit every finding in `findings.json` by its id, whether it is resolved, and its detail, and the findings the fixes
introduced, none when there are none.

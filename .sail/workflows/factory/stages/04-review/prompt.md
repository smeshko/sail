Review this branch adversarially before it goes out as a pull request. The change is `git diff origin/staging...HEAD`,
its commits are `git log origin/staging..HEAD`, and the plan it implements is at `{{plan}}`. Read the plan's Goal,
Scope and Decisions first: a finding that contradicts an explicit Decision is not a finding.

You review only. Don't change any file.

## Your lens: {{lens}}

- `bugs`: correctness, regressions, security, performance cliffs, missing edge cases and error paths, races, and
  anything that breaks a contract another module relies on.
- `tests`: production code shaped to its tests rather than to the behaviour (special-cased test inputs, hardcoded
  expected values), tests that would stay green with the behaviour broken, and test changes that weaken an
  assertion.
- `all`: both.

{{#if history}}
## Earlier rounds

`$STAGE_IN/history.json` holds every earlier round: its findings, numbered, and how each was triaged (fix, defer or
reject, with a rationale and the fix's commit). Verify each fix is sufficient, push back on any defer or reject whose
rationale you disagree with by reporting it again with your reason, and surface anything new, especially problems the
fixes themselves introduced. Don't report a finding again that is settled.

{{/if}}
## What to report

Report only what you can point at: a file, the input or state that triggers it, and what goes wrong. Run a test or the
typecheck when that settles a doubt. Leave out taste and speculation.

Give each finding a severity: `high` for a real bug that ships broken behaviour, `medium` for one with a narrow
trigger or a weak test that hides one, `low` for the rest.

## Submit

Submit a one-paragraph summary and every finding, with its severity, file, a one-line title and its detail.

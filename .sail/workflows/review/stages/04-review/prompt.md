Review this pull request adversarially, through one lens. The change is `git diff {{base}}...HEAD`, its commits are
`git log {{base}}..HEAD`, the pull request is described at `{{brief}}`, and what it should do at `{{requirements}}`.
Other reviewers cover the other lenses at the same time, and validation runs the tests: stay on yours.

You review only. Don't change any file.

## Your lens: {{lens}}

- `requirements`: does the change do what the requirements ask, all of it and nothing else? An acceptance criterion
  the change doesn't meet, or meets only on the path its tests take; behaviour the requirements didn't ask for; a
  requirement read differently from how it is written.
- `architecture`: does the change fit the codebase? A module reaching past its layer (`src/sdk`, `src/engine`,
  `src/ports`, `src/adapters`, `src/kinds`, `src/events`, `src/watch`, `src/dashboard`, `src/cli`), a port
  bypassed, a contract another module relies on changed, logic duplicated that exists already, an abstraction that
  doesn't earn its place, a term `CONTEXT.md` names differently.
- `quality`: is the code one a reader trusts? Naming, dead code, error handling that hides a failure, comments that
  say something other than the code, tests that would stay green with the behaviour broken, production code shaped
  to its tests, and anything `AGENTS.md` asks for that the change doesn't do.
- `bugs`: does it work? Correctness, regressions, missing edge cases and error paths, races, security, performance
  cliffs.

## What to report

Report only what you can point at: a file, the input or state that triggers it, and what goes wrong. Run a test or the
typecheck when that settles a doubt. Leave out taste and speculation, and what another lens covers.

Give each finding a severity: `high` for one that ships broken or wrong behaviour, `medium` for one with a narrow
trigger or that will cost the next change, `low` for the rest.

## Submit

Submit a one-paragraph summary through your lens and every finding, with its severity, file, a one-line title and its
detail.

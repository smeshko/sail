Find the open questions in this ticket. The ticket is at `{{brief}}`; the team's other open tickets are at `{{others}}`,
which you don't need here.

Imagine a planner who must turn this ticket into a plan with the repository open and nobody to ask. List what they could
not settle from the ticket and the repository: a choice between two behaviours, a missing acceptance criterion, a term
the ticket uses and the repository doesn't, a dependency on something undecided. Read the repository first, and ask
only what it can't answer. The repository includes `docs/`, a local copy of the design docs: ADRs in `docs/adr/`, plans
and their decisions in `docs/artifacts/plans/` (finished ones in `archive/`), epics in `docs/artifacts/epics/`. A
question that a decision there settles is not open: quote the decision and cite it as `docs/…:line` instead of asking.

Each question stands alone: a person reading only it knows what to answer. Don't ask for confirmation of what the
ticket already says, and don't ask about style. A clear ticket has no questions, and an empty list is the right answer.

You only read. Don't change any file.

## Submit

Submit the `questions`. Each one has:

- `ask`: the question, containing a `?`
- `options`: two to four, each with the `option` (a short name) and what choosing it `means` day to day
- `recommend`: the text of one option, exactly as in `options`, the one you would choose
- `why`: why you recommend it
- `cites`: at least one `file:line` (or `file:line-line`) in the repository that your recommendation rests on

A question that breaks one of these is rejected and you must submit again.

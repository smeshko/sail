Judge the findings on this pull request, and decide what each one becomes. The pull request is described at
`{{brief}}`, and what it should do at `{{requirements}}`.

`$STAGE_IN/findings.json` holds every finding, numbered: `V1` when validation (`bun run gate`) failed, `D<n>` for each
acceptance criterion the demonstration couldn't show, and `R<n>` from the four reviewers, each with the lens it came
from. `$STAGE_IN/evidence.json` holds how each check went as a whole: validation's output, the demonstration's
criteria and transcript, and each reviewer's summary.

## 1. Check each finding before you decide on it

Reviewers overreach, and two lenses often report one problem. For each finding, read the code it points at and confirm
it is real: the trigger exists, and what it says goes wrong does. Merge duplicates: decide the first, and drop the
others as duplicates of it. A failed validation or an unshown criterion is real unless its evidence shows the check
itself went wrong.

## 2. Decide

| Verdict | When |
|---|---|
| `fix` | it is real and belongs to this pull request: it breaks or misses what the requirements ask, fails validation, or ships a bug, and fixing it stays inside the change's scope |
| `ticket` | it is real but outside this pull request: older code the change only exposed, a refactor or a design question bigger than the change, an improvement the requirements didn't ask for |
| `drop` | it isn't real, it duplicates another finding, it contradicts the requirements, or it is taste |

A failed validation and an unshown criterion are `fix` unless the problem lies outside the change. Never `drop` a real
problem to keep the pull request moving: a real problem out of scope is a `ticket`.

For a `ticket`, write the ticket: a title, a description a reader can act on without this run (the files, what is
wrong, what triggers it), and its type: `bug`, `feature` or `refactoring`.

You decide only. Don't change any file.

## Submit

Submit a one-paragraph summary of the pull request's state, and a decision for every finding in `findings.json`: its
id, verdict and a one-sentence rationale, and for a `ticket` the ticket, null otherwise.

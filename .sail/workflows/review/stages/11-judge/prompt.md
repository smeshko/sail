Judge this pull request's review: decide what each finding becomes, and whether each review can be trusted. The pull
request is described at `{{brief}}`, and what it should do at `{{requirements}}`.

**Nobody stands between you and the merge.** Once the findings you send to `fix` are fixed and validation passes, the
pull request merges into `staging` on its own. A finding you `drop` ships as it is, and a review you trust is the only
look that part of the change gets.

`$STAGE_IN/findings.json` holds every finding, numbered: `V1` when validation (`bun run gate`) failed, `L<n>` for each
line the leak check flagged, `D<n>` for each acceptance criterion the demonstration couldn't show, and `R<n>` from the
six reviewers, each with the reviewer it came from. `$STAGE_IN/evidence.json` holds how each check went as a whole:
validation's output, the demonstration's criteria and transcript, and each reviewer's summary and coverage: what it
checked, how, and with what result.

## 1. Check each finding before you decide on it

Reviewers overreach, and two lenses often report one problem. For each finding, read the code it points at and confirm
it is real: the trigger exists, and what it says goes wrong does. Merge duplicates: decide the first, and drop the
others as duplicates of it. A failed validation or an unshown criterion is real unless its evidence shows the check
itself went wrong.

A leak-check hit is a tracker key other than `ADW-<n>`, or a term from a private denylist, on a line the change adds.
It is real unless the line shows it is something else: a test's placeholder key such as `ZZZ-1`, a version, a
standard's name.

## 2. Check each review's coverage

Read each reviewer's coverage against the change. A review is thin when its coverage leaves out what this change
needed checked under its question: an acceptance criterion with no entry, a changed function the bugs review never
traced, a new spawn the security review never looked at, an entry whose `how` shows nothing was read or run, or
`unchecked` entries on what matters. List each thin review with what it left out. A thin review stops the merge and
hands the pull request to a human, so name one only for a real gap, never for a short review of a small change.

## 3. Decide

| Verdict | When |
|---|---|
| `fix` | it is real and belongs to this pull request: it breaks or misses what the requirements ask, fails validation, or ships a bug, and fixing it stays inside the change's scope |
| `ticket` | it is real but outside this pull request: older code the change only exposed, a refactor or a design question bigger than the change, an improvement the requirements didn't ask for |
| `drop` | it isn't real, it duplicates another finding, it contradicts the requirements, or it is taste |

A failed validation and an unshown criterion are `fix` unless the problem lies outside the change. Never `drop` a real
problem to keep the pull request moving: a real problem out of scope is a `ticket`.

An unshown criterion is `fix` only when the demonstration ran its scenario and saw the wrong thing. When its evidence
says the harness couldn't run the scenario at all (a pipe, a second command alongside the first, a background process,
a test), no fix to the code can show it either: read the tests the change adds for it. When a test asserts the
criterion, `drop` the finding as covered by that test, naming it; when none does, it is `fix`, and the fix is that
test, never another attempt at the demonstration.

For a `ticket`, write the ticket: a title, a description a reader can act on without this run (the files, what is
wrong, what triggers it), and its type: `bug`, `feature` or `refactoring`.

You decide only. Don't change any file.

## Submit

Submit a one-paragraph summary of the pull request's state; the thin reviews, each with its reviewer and what it left
out, none when every review holds; and a decision for every finding in `findings.json`: its id, verdict and a
one-sentence rationale, and for a `ticket` the ticket, null otherwise.

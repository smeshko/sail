Judge this pull request's review: decide what each finding becomes, and whether each review can be trusted. The pull
request is described at `{{brief}}`, and what it should do at `{{requirements}}`.

**Nobody stands between you and the merge.** Once the findings you send to `fix` are fixed and validation passes, the
pull request merges into `staging` on its own. A finding you `drop` ships as it is, and a review you trust is the only
look that part of the change gets.

`$STAGE_IN/findings.json` holds every finding, numbered: `V1` when validation (`bun run gate`) failed, `L<n>` for each
tracker-key prefix or denylist term the leak check found, with its count and example locations, and for each line its Jev pass flagged, `B<n>` for each avoided word the banned-words check flagged, and `R<n>` from the
five reviewers at medium or above, each with the reviewer it came from. `$STAGE_IN/evidence.json` holds how each check went as a whole:
validation's output, the demonstration's criteria, each shown or not, and its transcript (they are evidence, never findings), and each reviewer's summary and coverage: what it
checked, how, and with what result.

`$STAGE_IN/triage.json` holds Jev's answers, its clear `decided` findings, and the `judge` ids it left to you.
Decide every finding in `judge` as below. A merge-stopping finding (high severity, or from validation, leak-check
or checks) is always yours, whatever Jev answered. For a Jev-decided finding, submit a decision only to
overrule Jev, after reading its code; omitting it keeps Jev's verdict. Spend your work on what remains unclear.

## 1. Check each finding before you decide on it

Reviewers overreach, and two lenses often report one problem. For each finding in `judge`, and any Jev-decided finding
you consider overruling, read the code it points at and confirm it is real: the trigger exists, and what it says goes
wrong does. You need not inspect the code for Jev decisions you keep. Merge duplicates: decide the first, and drop the
others as duplicates of it. A failed validation is real unless its evidence shows the check
itself went wrong.

A leak-check finding that gives a count covers every occurrence: decide it once, for all of them. Read its examples; it is
real unless they show every occurrence is something else. A leak-check hit is a tracker key other than `ADW-<n>`, or a term from a private denylist, on a line the change adds.
It is real unless the line shows it is something else: a test's placeholder key such as `ZZZ-1`, a version, a
standard's name. A Jev-pass hit is a comment, doc or commit-message line Jev reads as naming a project, company,
product or tracker other than sail. It is real unless the name is sail's own, a provider or tool sail integrates with,
or a generic word.

A banned-words hit (`B<n>`) is a word `CONTEXT.md` lists under an entry's `_Avoid_`, which Jev reads as used in the
forbidden sense. It is real when the line uses the word for what that entry defines. It isn't when the word means
something else, is quoted as a word, or is a name the change can't rename. A real one is a `fix` inside the change.

## 2. Check each review's coverage

Read each reviewer's coverage against the change. A review is thin when its coverage leaves out what this change
needed checked under its question: an acceptance criterion with no entry, a changed function the bugs review never
traced, a new spawn the bugs review never looked at, an entry whose `how` shows nothing was read or run, or
`unchecked` entries on what matters. List each thin review with what it left out. A thin review stops the merge and
hands the pull request to a human, so name one only for a real gap, never for a short review of a small change.

## 3. Decide

| Verdict | When |
|---|---|
| `fix` | it is real and belongs to this pull request: it breaks or misses what the requirements ask, fails validation, or ships a bug, and fixing it stays inside the change's scope |
| `ticket` | it is real, outside this pull request, and worth a ticket of its own as below: a bug in older code the change only exposed, a design question bigger than the change |
| `drop` | it isn't real, it duplicates another finding, it contradicts the requirements, it is taste, wording included, or it is real, out of scope and not worth a ticket |

A finding that only rewords a comment, a header, a help line, a doc or glossary phrasing is `drop`, as taste, unless
the text as it stands is wrong in a way that would mislead a reader or the next agent: a comment that names a
behaviour the code doesn't have, a help line that gives a wrong flag, a glossary term the change misuses. Then it is
`fix`, at its own severity, and the fix stage commits the minor ones together when a pass runs.

A failed validation is `fix` unless the problem lies outside the change. Never `drop` a real
problem in scope to keep the pull request moving.

## Raising an unshown criterion

Read each criterion in `evidence.json`'s demonstration with `shown: false`. Raise it only when no test the change adds
asserts it. When a test does, raise nothing and name that test in your summary. A criterion the demonstration ran and
saw go wrong is a bug the reviewers' findings or validation carry; when none does, raise it the same way.

A raised entry gives the `criterion` in the evidence's words and the `test` that would show it: its file and the
assertion. The fix is that test, or the code change that makes it pass, never another attempt at the demonstration.
The workflow numbers each raised criterion as a finding of its own, decides it `fix` and sends it to the fix pass. The list is for this
case only: every other problem is a finding the reviewers or the checks reported.

A ticket costs a reader's attention every time they pass it, and sail has one maintainer, who writes every adapter and
workflow. File one only when doing it changes something a person would notice: a failure someone hit or can reach
through a real path, a behaviour someone asked for, or a measured cost. Never file hardening against a misuse no caller
makes or an input no path produces, a tidy-up with no behaviour behind it (a rename, a move, a shared helper, a
comment, an unused field), a test for code with no reported failure, or anything smaller than writing it up. A
run files at most two tickets, bugs first.

For a `ticket`, write the ticket: a title, a description a reader can act on without this run (the files, what is
wrong), the `trigger` (the command, input or code path that reaches the problem), and its type: `bug`, `feature` or
`refactoring`. A finding you can name no trigger for is not a ticket.

You decide only. Don't change any file.

## Submit

Submit a one-paragraph summary of the pull request's state; the thin reviews, each with its reviewer and what it left
out, none when every review holds; and a decision for every id in `triage.json`'s `judge`, plus any Jev-decided
finding you overrule: its id, verdict and a one-sentence rationale, and for a `ticket` the ticket, null otherwise.
Do not restate Jev decisions you keep. Also submit `raised`, the criteria you raise as above, each with its `criterion` and
`test`; leave it out or empty when there is none.

Groom this ticket: judge three checks of it, write the report, and choose what to do to the ticket. The ticket is at
`{{brief}}`, and the team's other open tickets are at `{{others}}`. `$STAGE_IN/findings.json` holds what the three checks
found: `duplicates` (up to three open tickets Jev ranked closest to this one, each with Jev's score as its `confidence`,
and `unchecked`, the reason Jev could not be asked, in which case the list is empty and no ticket was compared), `worth` (keep or cancel, the tickets to merge with, each with a
confidence, and `stale` with its `staleEvidence`) and `questions`. `questions` is empty when the worth check said cancel, since the questions check
didn't run.

When the ticket's `## Rulings` answered every question the last grooming asked, the three checks did not run: `findings`
then holds no candidates, a `keep` whose `why` says the checks were skipped, and no questions. Write the report's sections
from the earlier report in the brief's comments and from the rulings, verifying what you rely on as you would a check's
finding. A `cancel`, a `merge` or a `duplicate` you choose is not applied on such a run, as no check backs it.

Be hard on the ticket. Every ticket in the backlog must earn its place: a small, useless one should not exist, and work
that one pull request would do belongs in one ticket. Prefer, in this order: merging the ticket with another, canceling
it, then keeping it.

## 1. Check each finding

The checks overreach in both directions. Read the ticket and the repository (`git grep`, `git log`) and confirm what each
check says before you rely on it. A duplicate needs the same change as the other ticket, not the same area; a merge needs
work that one pull request would naturally do; a staleness claim needs evidence you have verified yourself; a question the
repository answers is not open. That includes `docs/`, a local copy of the design docs (ADRs in `docs/adr/`, plans and
their decisions in `docs/artifacts/plans/`, epics in `docs/artifacts/epics/`): drop a question a decision there answers,
and quote the decision.

The duplicates candidates are a ranking to check, not a verdict: read each one in `others.md` and decide yourself
whether it is the same work. A score rarely reaches 0.8 even for the same work, so when a candidate is the same work and
the worth check names it too, choose `merge`. When `unchecked` is set, say in the report that the duplicates check did
not run and why, and look through `others.md` yourself.

## 2. Write the report

The report is the document at `$STAGE_OUT/report.md`, from its template. Fill each placeholder in place. It is posted as
one comment on the ticket for a person to read, so write for them, plainly and briefly. Don't quote the ticket back.

## 3. Choose the actions

Choose from this set, and nothing else is available to you:

| Action | Use it when |
|---|---|
| `merge` `into`, `absorb`, `description` | the ticket and others are one piece of work: `into` survives, each of `absorb` is folded into it |
| `cancel` `reason` | the ticket is not worth doing, or is stale, and no other ticket could carry it |
| `duplicate` `of` | the ticket asks for the same change as the ticket `of`, and `of` already says all of it |
| `labels` `set` | the ticket's labels are wrong or missing: `set` names its `type`, `platform` and, when one fits, `source` |
| `related` `to` | another ticket is different work in the same code or toward the same goal, and a reader of either should know |
| `blocks` `to` | this ticket must land before the ticket `to` can |
| `blocked_by` `to` | the ticket `to` must land before this one can start: an unlanded prerequisite, never `related` |
| `manual` `reason` | the ticket is real work but not the factory's: it needs no code change, needs a measurement or a person's walkthrough, or belongs in another repository |
| `edit` `title` and/or `description` | the title misleads, or the description lacks what you verified, such as the files involved |

**Merge.** This ticket is `into` or one of `absorb`. Make the survivor the broader ticket, or the older one when neither
is broader. `description` is the survivor's whole new description: keep everything its author wrote that is still true,
then add a section `## Merged from <key>` for each absorbed ticket, holding its ask and its acceptance criteria in a few
lines. One `merge` per run, absorbing at most five tickets.

**Related is not a weak merge.** When the worth check named a ticket at 0.6 or more, or you would put one pull request
over both, choose `merge`, not `related`. Use `related` only for work that stays separate.
A prerequisite that has not landed is `blocked_by`, which the watcher waits on, never `related`.

**Labels.** Every ticket carries exactly one type (`feature`, `bug`, `refactoring`), exactly one platform (`core`, `cli`,
`dashboard`), and at most one source (`dogfooding`, `code-review`, `field-report`). Choose `labels` whenever the ticket
breaks that rule or carries a wrong one; leave out `source` when none fits. Set the labels of a ticket you cancel or
absorb too: they say what the backlog let go.

The code holds back the actions that remove a ticket. A `cancel` passes when the worth check found the ticket
stale, or the worth check gave `cancel` at 0.6 or more, or `keep` under 0.6 (for a ticket labelled `code-review`: `cancel`
at 0.5, or `keep` under 0.7); a `merge` passes only when the worth check named each other ticket in it at 0.65 or more,
or the duplicates check at 0.8 or more; a `duplicate` only when the duplicates check named `of` at 0.8 or more. A started ticket or an epic is never canceled or merged away. Choose the action when you believe it,
whatever the numbers; the code limits it, you don't, and it reports what it held back. You cannot move a ticket to any
other state or file a ticket. Never act on this ticket's own key as the other end of a relation.

An edit keeps everything the author wrote that is still true. Change a title only when it is wrong or hides the ask. A
ticket that needs no action has an empty `actions` list.

## 4. List the open questions

`questions` lists the open questions you confirmed which a person must answer before the ticket can be planned, **at most
two**: keep the two a person most needs to answer. Settle every other one yourself, with the choice you would make, and
list each under `## Assumptions` in the report with that choice and why. The report does not write the open questions: the
act step posts the ones you submit, with their options, under `## Open questions`.

Each has the shape the questions check uses: an `ask` containing a `?`, two to four `options` each with what
choosing it `means` day to day, `recommend` (one option's text, exactly), `why`, and `cites` of at least one `file:line`.
A question that breaks the shape, or a third question, is rejected and you must submit again. The ticket is labelled
`open-questions` while any remain. Otherwise a planner plans it next, from the ticket, your report and the actions the
workflow applies, so the `## Assumptions` you write are choices it builds on. A ticket you cancel or merge away has
none, and is never planned. A ticket you rule `manual` is labelled `manual`, never planned, and has no open questions:
submit `questions` empty.

A `## Rulings` section in the ticket's description holds a person's answers to questions an earlier grooming asked. A
question a ruling answers is not open: never ask it again.

## Submit

Submit a one-paragraph `summary`, the `actions` and the `questions`.

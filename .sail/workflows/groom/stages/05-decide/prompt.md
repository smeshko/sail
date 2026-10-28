Groom this ticket: judge four checks of it, write the report, and choose what to do to the ticket. The ticket is at
`{{brief}}`, and the team's other open tickets are at `{{others}}`. `$STAGE_IN/findings.json` holds what the four checks
found: `duplicates` (candidates with a confidence), `worth` (keep or cancel, and the tickets to merge with, each with a
confidence), `staleness` and `questions`.

Be hard on the ticket. Every ticket in the backlog must earn its place: a small, useless one should not exist, and work
that one pull request would do belongs in one ticket. Prefer, in this order: merging the ticket with another, canceling
it, then keeping it.

## 1. Check each finding

The checks overreach in both directions. Read the ticket and the repository (`git grep`, `git log`) and confirm what each
check says before you rely on it. A duplicate needs the same change as the other ticket, not the same area; a merge needs
work that one pull request would naturally do; a staleness claim needs evidence you have verified yourself; a question the
repository answers is not open.

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
| `related` `to` | another ticket touches the same code or the same goal, and a reader of either should know |
| `blocks` `to` | this ticket must land before the ticket `to` can |
| `edit` `title` and/or `description` | the title misleads, or the description lacks what you verified, such as the files involved |

**Merge.** This ticket is `into` or one of `absorb`. Make the survivor the broader ticket, or the older one when neither
is broader. `description` is the survivor's whole new description: keep everything its author wrote that is still true,
then add a section `## Merged from <key>` for each absorbed ticket, holding its ask and its acceptance criteria in a few
lines. One `merge` per run, absorbing at most five tickets.

**Labels.** Every ticket carries exactly one type (`feature`, `bug`, `refactoring`), exactly one platform (`core`, `cli`,
`dashboard`), and at most one source (`dogfooding`, `code-review`, `field-report`). Choose `labels` whenever the ticket
breaks that rule or carries a wrong one; leave out `source` when none fits. Set the labels of a ticket you cancel or
absorb too: they say what the backlog let go.

The code holds back the actions that remove a ticket. A `cancel` passes only when the worth check gave `cancel` at a
confidence of 0.8 or more, or the staleness check found the ticket stale; a `merge` passes only when the worth or
duplicates check named each other ticket in it at 0.8 or more; a `duplicate` only when the duplicates check named `of` at
0.8 or more. A started ticket or an epic is never canceled or merged away. Choose the action when you believe it,
whatever the numbers; the code limits it, you don't, and it reports what it held back. You cannot move a ticket to any
other state or file a ticket. Never act on this ticket's own key as the other end of a relation.

An edit keeps everything the author wrote that is still true. Change a title only when it is wrong or hides the ask. A
ticket that needs no action has an empty `actions` list.

## 4. List the open questions

`questions` lists the open questions you confirmed, each standing alone, which a person must answer before the ticket can
be planned. The ticket is labelled `open-questions` while any remain, and `groomed` otherwise. A ticket you cancel or
merge away has none.

## Submit

Submit a one-paragraph `summary`, the `actions` and the `questions`.

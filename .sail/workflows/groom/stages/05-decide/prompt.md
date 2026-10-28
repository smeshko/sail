Groom this ticket: judge three checks of it, write the report, and choose what to do to the ticket. The ticket is at
`{{brief}}`. `$STAGE_IN/findings.json` holds what the three checks found: `duplicates` (candidates with a confidence),
`staleness` and `questions`.

## 1. Check each finding

The checks overreach. Read the ticket and the repository (`git grep`, `git log`) and confirm what each check says before
you rely on it. A duplicate needs the same change as the other ticket, not the same area; a staleness claim needs evidence
you have verified yourself; a question the repository answers is not open.

## 2. Write the report

The report is the document at `$STAGE_OUT/report.md`, from its template. Fill each placeholder in place: the summary,
the duplicates, the staleness and the open questions. It is posted as one comment on the ticket for a person to read, so
write for them, plainly and briefly. Don't quote the ticket back.

## 3. Choose the actions

Choose from this set, and nothing else is available to you:

| Action | Use it when |
|---|---|
| `duplicate` `of` | the ticket asks for the same change as the ticket `of`, which the duplicates check named |
| `related` `to` | another ticket touches the same code or the same goal, and a reader of either should know |
| `blocks` `to` | this ticket must land before the ticket `to` can |
| `edit` `title` and/or `description` | the title misleads, or the description lacks what you verified, such as the files involved |

A `duplicate` cancels the ticket, so the code holds it back: it marks the ticket only when the duplicates check named
`of` with a confidence of 0.8 or more, and otherwise reports it in the comment. Choose `duplicate` when you believe it,
whatever the number; the code limits it, you don't. You cannot move a ticket to another state, label it, or file a
ticket: those are not available. Never act on this ticket's own key as the other end of a relation.

An edit keeps everything the author wrote that is still true. Change a title only when it is wrong or hides the ask. A
ticket that needs no action has an empty `actions` list.

## Submit

Submit a one-paragraph `summary` and the `actions`.

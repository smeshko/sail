Judge whether this ticket earns its place in the backlog, and which open tickets it should become one ticket with. The
ticket is at `{{brief}}`, and the team's other open tickets (unstarted or started), with their labels and the start of
their descriptions, are at `{{others}}`.

Be hard on it. A backlog is worked from the top, and every ticket in it costs a reader's attention each time they pass
it. A ticket earns its place only when doing it changes something a person would notice: a failure someone hit or can
reproduce, a behaviour a user asked for, a cost or a delay that is measured. Read the repository (`git grep`, `git log`)
to see what the ticket would change before you judge it.

## Cancel

Give `cancel` when the ticket is not worth doing on its own and no other ticket could carry it. Cancel:

- hardening against a situation nobody is in: sail has one maintainer, who writes every adapter and workflow, so a guard
  against a hypothetical outside author, a misuse no caller makes, or an input no path produces is not worth a ticket
- a tidy-up with no behaviour behind it: a rename, a move, a shared helper for two call sites, a comment
- a test for code with no reported failure, or a test that only restates what another already proves
- anything so small that writing it up cost more than doing it would

Give `keep` only when you can name what makes it worth doing: the failure and the path that reaches it, the person or
ticket that asked for the behaviour, or the measured cost. Put that in `why`. A real bug is kept however small; a missing
feature that someone asked for is kept. A ticket you can't make that case for is a `cancel`, and a ticket a review filed
(labelled `code-review`) has no person behind it, so it needs the case made from the code alone.

## Merge

A merge makes one ticket of several. Name every open ticket in `others.md` that this one should become one ticket with:
the same root cause, the same module and goal so that one pull request would naturally do both, or one ask that is a
step of the other. A small ticket that is part of a bigger one belongs merged into it, not kept beside it, and not
canceled when the bigger one would carry it. Prefer a merge to a cancel whenever another ticket could carry the work.

For each, give its `ticketKey`, a one-sentence `why`, and a confidence from 0 to 1:

- 0.9 or more: one pull request would do both, and you read the code each would touch.
- 0.6 to 0.9: very likely, but you have only the titles and descriptions to go on.
- under 0.6: the same area, probably separate work.

Be calibrated, because the numbers act. A `cancel` at 0.6 or more lets the judge cancel the ticket, and so does a
`keep` under 0.6: a keep you are unsure of is no case for keeping. For a ticket labelled `code-review` the bars are a
`cancel` at 0.5 and a `keep` under 0.7. A merge at 0.65 or more lets the judge merge the tickets. Give each number as
you would act on it yourself. List no ticket you would put under 0.3.

You only read. Don't change any file.

## Submit

Submit the `verdict` (`keep` or `cancel`), its `confidence` and `why`, and the `merges`: each with its `ticketKey`,
`confidence` and `why`. An empty `merges` list is a fine answer.

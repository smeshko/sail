Find the open tickets that describe the same work as this one. The ticket is at `{{brief}}`, and the team's other open
tickets (unstarted or started) are at `{{others}}`: one `## <ticket key>` section each, with its state, labels, title and
the start of its description.

`others.md` can hold a hundred tickets or more, so search it; don't read it whole. Read the ticket, then `grep -n -i` the
file for what it is about: the commands, files, modules, events and error messages it names, and the words for its
outcome, with their synonyms and the other ways the backlog might put it. Read the sections the matches fall in, and
search again with the words you find there. Stop when no new search turns up a ticket you haven't read.

Two tickets are the same work when doing one would do the other: the same outcome in the same place, however each is
worded. A ticket in the same area that asks for a different change is not a duplicate, and neither is one that is only
a step of the other.

For each duplicate, give its `ticketKey`, a one-sentence `why` that names what both ask for, and a confidence from 0 to 1:

- 0.8 or more: one would close the other; you would mark this ticket a duplicate of it yourself.
- 0.5 to 0.8: probably the same work, but the descriptions leave room for a difference.

Be calibrated, because the numbers act: a duplicate at 0.8 or more lets the judge mark this ticket a duplicate, which
cancels it. List no ticket you would put under 0.5.

You only read. Don't change any file.

## Submit

Submit the `candidates`, highest confidence first, each with its `ticketKey`, `confidence` and `why`. An empty list is
the right answer when no open ticket is the same work.

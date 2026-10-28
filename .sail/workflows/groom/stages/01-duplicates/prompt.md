Check whether this ticket duplicates another open ticket. The ticket is at `{{brief}}`, and the team's other open tickets
(unstarted or started), by title, are at `{{others}}`.

A duplicate asks for the same change as another ticket: the same outcome in the same place, not merely the same area.
Two tickets that touch one file for different reasons are related, not duplicates. For each ticket in `others.md` that
could be a duplicate, name its ticket key, say why in one sentence, and give a confidence from 0 to 1:

- 0.9 or more: the same change, worded differently, and you checked the repository for what each would touch.
- 0.6 to 0.9: very likely the same, but the titles are all you have to go on or a detail differs.
- under 0.6: the same area, probably a different change.

Be calibrated: a confidence of 0.8 or more marks the ticket as a duplicate and cancels it, so give it only when you would
do so yourself. You can read the repository (`git log`, `git grep`) to see what each ticket would change. List no ticket
you would put under 0.3. An empty list is a fine answer.

You only read. Don't change any file.

## Submit

Submit the candidates: each with its `ticketKey`, `confidence` and `why`.

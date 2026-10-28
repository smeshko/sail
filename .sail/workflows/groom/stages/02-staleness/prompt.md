Check whether this ticket is stale: whether the repository already does what it asks. The ticket is at `{{brief}}`; the
team's other open tickets are at `{{others}}`, which you don't need here.

Read what the ticket asks for, then look in the repository for it: `git grep` for the names and behaviours it mentions,
`git log` for a commit that did it, and the files it points at. A ticket is stale when everything it asks for is
already there, or when what it describes no longer exists. A ticket that is partly done is not stale: say which part
in the evidence.

Quote what you found (a file and line, or a commit subject), never a guess. When you find nothing, the ticket is not
stale, and the evidence says what you looked for.

You only read. Don't change any file.

## Submit

Submit `stale` (true or false) and the `evidence`.

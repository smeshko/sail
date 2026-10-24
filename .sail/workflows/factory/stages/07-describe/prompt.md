Describe the change on this branch for its pull request into `staging`, from the ticket, the plan at `{{plan}}`, the
review at `{{review}}`, and the commits (`git log origin/staging..HEAD`).

Write `pr-body.md` with these sections:

- **Summary**: what changes and why, in two or three sentences, in `CONTEXT.md`'s terms.
- **Changes**: one bullet per commit or group of related commits.
- **Testing**: the tests the plan added and what they prove, and `bun run gate` passing. CI runs the full
  `bun run verify`.
- **Review**: `REVIEW.md` as it is.
- **Follow-ups**: each deferred finding, and each follow-up you submit, one bullet each, or leave the section out when
  there is none. Each is filed as a ticket once the pull request is open.

End the body with `Closes <ticket key>` on its own line. The repository is public: name only sail and its `ADW-<n>`
issues, never another project or tracker.

Submit the title, a Conventional Commits subject ending with the ticket key in parentheses, and `pr-body.md` as the
body file.

Submit as `followUps` the work outside this branch that the plan's Out of Scope, the implementation's notes or the
review surfaced, and that someone should pick up: a bug the change exposed, a guard left inconsistent, a refactor it
put off. Give each a title, a description a reader can act on without this run (the files, what is wrong, why it was
left), and its type: `bug`, `feature` or `refactoring`. Leave out the deferred review findings, which are filed
already, and anything the plan rules out as unwanted. Submit none when there is none: an empty list is the usual
answer.

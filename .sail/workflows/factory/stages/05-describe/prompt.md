Describe the change on this branch for its pull request into `staging`, from the ticket, the plan at `{{plan}}`, and
the commits (`git log origin/staging..HEAD`).

Write `pr-body.md` with these sections:

- **Summary**: what changes and why, in two or three sentences, in `CONTEXT.md`'s terms.
- **Changes**: one bullet per commit or group of related commits.
- **Testing**: the tests the plan added and what they prove, and `bun run gate` passing. CI runs the full
  `bun run verify`.
- **Demonstration**: the plan's Demonstration section as it is: its surface, then each acceptance criterion's
  scenario and what to observe. The review workflow runs these scenarios against the pull request, so keep them
  exact. For a surface of `none`, its one line saying why nothing can be shown.
- **Follow-ups**: each follow-up you submit, one bullet each, or leave the section out when there is none. Each is
  filed as a ticket once the pull request is open.

End the body with `Closes <ticket key>` on its own line. The repository is public: name only sail and its `ADW-<n>`
issues, never another project or tracker.

Submit the title, a Conventional Commits subject ending with the ticket key in parentheses, and `pr-body.md` as the
body file.

Submit as `followUps` the work outside this branch that the plan's Out of Scope or the implementation's notes
surfaced, and that someone should pick up: a bug the change exposed, a guard left inconsistent, a refactor it
put off. Give each a title, a description a reader can act on without this run (the files, what is wrong, why it was
left), and its type: `bug`, `feature` or `refactoring`. Leave out anything the plan rules out as unwanted. Submit none when there is none: an empty list is the usual
answer.

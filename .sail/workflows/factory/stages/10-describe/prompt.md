Describe the change on this branch for its pull request into `staging`, from the ticket, the plan at `{{plan}}`, the
review at `{{review}}`, and the commits (`git log origin/staging..HEAD`).

Write `pr-body.md` with these sections:

- **Summary**: what changes and why, in two or three sentences, in `CONTEXT.md`'s terms.
- **Changes**: one bullet per commit or group of related commits.
- **Testing**: the tests the plan added and what they prove, and `bun run gate` passing. CI runs the full
  `bun run verify`.
- **Review**: `REVIEW.md` as it is.
- **Follow-ups**: each deferred finding, one bullet each, or leave the section out when there is none.

End the body with `Closes <ticket key>` on its own line. The repository is public: name only sail and its `ADW-<n>`
issues, never another project or tracker.

Submit the title, a Conventional Commits subject ending with the ticket key in parentheses, and `pr-body.md` as the
body file.

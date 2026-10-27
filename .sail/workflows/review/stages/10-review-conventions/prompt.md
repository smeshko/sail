Review this pull request for one question: does the change follow AGENTS.md and CONTEXT.md, and is it fit for a public
repository? Five other reviewers cover requirements, architecture, bugs, tests and security at the same time, and
validation runs the typecheck, lint and the affected tests: stay on your question.

The change is `git diff {{base}}...HEAD`, its commits are `git log {{base}}..HEAD`, the pull request is described at
`{{brief}}`, and what it should do at `{{requirements}}`. Read past the diff: the code around each change, its callers
and its tests are where most problems hide.

You review only. Don't change any file.

## Method

1. Read `AGENTS.md` and `CONTEXT.md` first: they are the rules.
2. Commits (`git log {{base}}..HEAD`): one per task, Conventional Commits, each subject ending with its ticket key.
3. Vocabulary: identifiers, event names, schema fields, comments, docs and commit messages use `CONTEXT.md`'s terms,
   never one it lists under _Avoid_. A new term is added to `CONTEXT.md` in the same change.
4. Generated files: `types/` regenerated after a change to `src/sdk`, the golden fixtures after a change to what a run
   writes or the dashboard draws, as `AGENTS.md` says.
5. Public repository: committed text names only sail and its `ADW-<n>` issues. A script already scans the added lines
   for other tracker keys and a denylist; you look for what a grep can't see: another project or employer described
   without its name, an internal URL or host, a path or a name that identifies a person's machine.
6. Comments and docs: each says what the code does now. A comment the change made stale, a doc it didn't update, a name
   that reads as something else.

## Checklist

- Commits: one per task, Conventional Commits, the ticket key in each.
- `CONTEXT.md`'s vocabulary kept, and new terms added to it.
- Generated files regenerated.
- Nothing private in committed text.
- Comments and docs current.

## What to report

A finding is something you can point at: the file and line, the input or state that triggers it, and what goes wrong.
Run a test or the typecheck when that settles a doubt. Leave out taste, speculation, and another reviewer's question.

Give each finding a severity: `high` for one that ships broken, wrong or unsafe behaviour, `medium` for one with a
narrow trigger or that will cost the next change, `low` for the rest.

## Coverage

Submit, beside your findings, what you checked: one entry per rule of AGENTS.md the change is subject to, and one entry
per checklist item above. Each entry says `what` you checked, `how` (the files and lines you read, the command you ran
and what it printed), and its `status`: `holds` when it checked out, `finding` when it gave a finding you submit, or
`unchecked` when you couldn't check it, with why in `how`. A checklist item that doesn't apply to this change gets one
`holds` entry saying why.

The judge reads your coverage. A review whose coverage leaves out what this change needed checked isn't trusted, and the
pull request waits for a human instead of merging. Nothing to report is a fine answer when your coverage shows why.

## Submit

Submit a one-paragraph summary of what you found through your question, your coverage, and every finding with its
severity, file, a one-line title and its detail.

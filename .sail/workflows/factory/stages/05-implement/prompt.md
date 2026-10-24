Implement the plan at `{{plan}}`: walk its tasks in order, and make exactly one commit per task. Read the plan end to
end first: its Goal, Scope, Decisions and Acceptance Criteria bound everything you do.

{{#if lock.testsCommit}}
The plan's tests are already written and committed, red-proven and pending, at `{{lock.testsCommit}}`. `{{red}}` records
how each one failed against the stubs. **The committed tests are the contract**: the only test change you make is
stripping the current task's stickers. Reach green through production code.
{{else}}
The plan has no pending tests. Write a task's tests first, each non-vacuous (break the behaviour and it goes red) and
tight (one per acceptance behaviour, asserting the exact value), then implement.
{{/if}}

{{#if feedback}}
## The last pass failed validation

`$STAGE_IN/feedback.json` holds what validation found: paths left uncommitted, test violations, and how
`bun run gate` ended, each failing test named with its error. Your commits from that pass are on the branch. Fix what
it reports first, in commits of their own (`fix(<scope>): …`), then carry on with any task not yet committed.

{{/if}}
## For each task, in order

1. Re-read the task's details and the files it lists, so your change fits the code as it is now.
2. **Red** (`impl` tasks): strip the task's stickers and run its tests. Each must fail as `red.txt` records.
   ```bash
   bun .sail/lib/strip-stickers.mjs --task TASK-001
   bun run fix
   bun run test <the task's test files>
   ```
3. **Green**: change production code until the task's tests pass, and the test files beside the code you changed.
   **Refactor**: production code only, the tests staying green.
4. **Checklist** tasks are non-code work, such as `bun run types` or `bun run golden`: run their steps in order.
5. **Verify the acceptance** with the evidence the task names: run the tests and keep the output. Code that compiles or
   looks right is not evidence. Don't commit a task whose acceptance fails.
6. Run `bun run typecheck` and `bun run lint`. Run test files by name, never a folder or the whole suite, and never
   `bun run gate`: a broad run outlasts your 10-minute command limit, and validation runs the affected tests after
   the last task.{{#if lock.testsCommit}} Then run `bun .sail/lib/check-tests.mjs {{lock.testsCommit}}`: its
   `violations` must list only the stickers of later tasks.{{/if}}
7. **Commit**: stage every path the task changed by name (`git add <paths>`, never `-A` or `.`), and commit with the
   task's suggested subject, its type or scope changed only if the diff demands it, ending with the ticket:
   `feat({{commit.scope}}): <what it does> ({{commit.ticketKey}})`.

## When something is wrong

- A test that won't pass, or acceptance you can't meet: end the step **blocked**, saying what you tried and what
  failed. Never commit a partial result, and never skip to the next task.
- A committed test that contradicts the plan, or calls a signature the task can't provide: end the step **blocked**,
  naming the test and the change it needs. Never edit it.
- Files that drifted from the plan: follow the code as it is, and say so in your notes.
- Work the plan doesn't list: leave it, and say so in your notes. Don't invent tasks.

## Submit

Submit each task with its commit's sha and the evidence that proves its acceptance, and a short note on anything you
did differently from the plan.

Implement the plan at `{{plan}}`: walk its tasks in order, test first, and make exactly one commit per task. Read the
plan end to end first: its Goal, Scope, Decisions and Acceptance Criteria bound everything you do.

{{#if feedback}}
{{#if feedback.validation}}
## The last pass failed validation

`$STAGE_IN/feedback.json` holds, under `validation`, what validation found: paths left uncommitted, and how
`bun run gate` ended, each failing test named with its error. Your commits from that pass are on the branch. Fix what
it reports first, in commits of their own (`fix(<scope>): …`), then carry on with any task not yet committed.

{{/if}}
{{#if feedback.tasks}}
## The last pass left tasks unimplemented

Validation passed, but a check of the branch against the plan found tasks it doesn't implement.
`$STAGE_IN/feedback.json` holds, under `tasks`, each task with whether it is implemented and what is missing. Your
commits from that pass are on the branch. Implement each missing task, or the part of it that is missing, the way the
steps below say, in a commit of its own.

{{/if}}
{{/if}}
## For each task, in order

1. Re-read the task's details and the files it lists, so your change fits the code as it is now.
2. **Red** (`impl` tasks): write the task's tests first, and run them to watch each fail on its assertion, not on an
   import or a type error. Give a new symbol its final signature and a body that returns a wrong value of the right
   type, so the test reaches its assertion.
   - One test per acceptance behaviour, plus one per branch that breaks on its own (a boundary, an error path), each
     asserting the exact value. Name it after the behaviour.
   - Every test is non-vacuous: name to yourself the regression it catches, and check that breaking the behaviour
     (revert the change, flip a condition, return a constant) turns it red. No assertion on a mock the test set up
     itself, no expected value computed by the code under test, no loop over an empty table.
   - Follow `test/`'s layout and style: `test/cli/run.test.ts` tests `src/cli/index.ts`, and anything touching git or
     `HOME` runs inside `withTempRepo()`. A behaviour the existing tests already cover gets those tests updated.
3. **Green**: change production code until the task's tests pass, and the test files beside the code you changed.
   **Refactor** with the tests staying green. Never weaken a test to make it pass.
4. **Checklist** tasks are non-code work, such as `bun run types` or `bun run golden`: run their steps in order.
5. **Verify the acceptance** with the evidence the task names: run the tests and keep the output. Code that compiles or
   looks right is not evidence. Don't commit a task whose acceptance fails.
6. Run `bun run typecheck` and `bun run lint`. Run test files by name, never a folder or the whole suite, and never
   `bun run gate`: a broad run outlasts your 10-minute command limit, and validation runs the affected tests after the
   last task. `bun scripts/affected-tests.ts --list` prints the test files your change selects.
7. **Commit** the task's tests and code together: stage every path it changed by name (`git add <paths>`, never `-A`
   or `.`), then `git commit -m '<subject>'`, the task's suggested subject, its type or scope changed only if the diff
   demands it, ending with the ticket: `feat({{commit.scope}}): <what it does> ({{commit.ticketKey}})`. Write the
   message as one single-quoted `-m`: a message built with `$(…)` or a heredoc can't be checked, and is denied.

Read files with the Read tool, or `sed -n` for a range. Change them only with Edit and Write: `sed -i`, `python3` and
a heredoc into a file are denied, and each denial costs a turn.

## When something is wrong

- A test that won't pass, or acceptance you can't meet: end the step **blocked**, saying what you tried and what
  failed. Never commit a partial result, and never skip to the next task.
- Files that drifted from the plan: follow the code as it is, and say so in your notes.
- Work the plan doesn't list: leave it, and say so in your notes. Don't invent tasks.

## Submit

Submit each task with its commit's sha and the evidence that proves its acceptance: the tests that went red, then
green. Add a short note on anything you did differently from the plan.

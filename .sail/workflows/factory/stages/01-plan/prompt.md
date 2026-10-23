Write an implementation plan for the change the brief asks for. You only plan: read the code, never change it.

## 1. Explore

Gather enough context to plan without guessing:

- Read the brief at `{{brief}}` in full: the ticket, its acceptance criteria and its comments.
- Locate the entry points, types, modules and tests the change touches, under `src/` and `test/`. Follow imports and
  calls far enough to see how the pieces connect. Read `CONTEXT.md` for the terms to use.
- Check recent history for related changes: `git log --oneline -20`.
- Note the files likely to change, the patterns to follow, the constraints, and what is still uncertain.

## 2. Resolve every question yourself

No one answers questions during this run. Settle each open point from the ticket, the code and the conventions, and
record it as a Decision or an Assumption. Where two approaches exist, reason through both, pick one and record why.

If the ticket is too vague to plan without guessing its goal or its acceptance, end the step **blocked**, naming the
questions a human must answer. Don't plan around a guess.

## 3. Write the plan

`plan.md` in `$STAGE_OUT` holds the plan's template: complete it in place, replacing every placeholder and keeping its
headings. Reference concrete paths and function names, never vague descriptions.

Classify the risk:

| Risk | Meaning |
|---|---|
| `tiny` | under 30 min, a single file, no new tests |
| `small` | under 2 h, isolated, existing tests cover it |
| `medium` | half a day, cross-file, new tests required |
| `large` | days, an architectural change, significant test work |
| `high` | critical path, infrastructure, or a breaking change |

Break the work into tasks, numbered `TASK-001`, `TASK-002`, … in order:

- Each task is small enough to make one commit. Prefer additive, incremental steps over large rewrites.
- `impl` is code work, proven by tests; `checklist` is anything else, such as regenerating `types/` or the golden run.
- A task's Acceptance items are each demonstrable at runtime, and its Evidence line names the output that proves them:
  a named test passing, a command transcript, a log excerpt.
- A task's suggested commit is a Conventional Commits subject, `feat(<scope>): <what it does>`, with no ticket
  reference: the workflow appends it.
- Final validation is not a task: the workflow runs `bun run verify` and the test check after the last task.

## 4. Submit

Submit the plan's slug (kebab-case, a few words), the Conventional Commits scope its commits share, its risk, and its
tasks, each with its id, title, type and suggested commit, matching the plan's Tasks list.

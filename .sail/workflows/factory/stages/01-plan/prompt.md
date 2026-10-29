Write an implementation plan for the change the brief asks for. You only plan: read the code, never change it.

## 1. Explore

Gather enough context to plan without guessing:

- Read the brief at `{{brief}}` in full: the ticket, its acceptance criteria and its comments.
- Locate the entry points, types, modules and tests the change touches, under `src/` and `test/`. Follow imports and
  calls far enough to see how the pieces connect. Read `CONTEXT.md` for the terms to use.
- Check recent history for related changes: `git log --oneline -20`.
- Note the files likely to change, the patterns to follow, the constraints, and what is still uncertain.

You read and never run: not the tests, not the gate, and no scratch file outside `$STAGE_OUT`. Reason from the code
and the tests as written: the tests take minutes, and validation runs them after implement.

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
- A task's tests are part of the task: implement writes them first, in the task's own commit. Never plan a task that
  only writes tests, or one that only makes earlier tests pass.
- Final validation is not a task: the workflow runs `bun run gate` after the last task.
- Implement may write only `src/`, `test/`, `types/`, `schemas/`, `bin/`, `scripts/`, `.sail/`, `.githooks/`, the root
  configs (`package.json`, `bun.lock`, `bunfig.toml`, `tsconfig.json`, `biome.json`), `AGENTS.md` and `CONTEXT.md`.
  If the change needs any other path, end the step **blocked**, naming the path: implement would block on it.
- Implement may add an npm dependency with `bun add --exact <package>`, and the task that first imports it adds it.
  A program installed on the machine is not one: CI has only what `package.json` and `bun.lock` name.

## 4. Plan the demonstration

Once the pull request is open, the review workflow shows the change working the way a user would see it, and checks it
against the plan's Demonstration section, which the pull request's body carries and you write now, before any code
exists. Pick the change's surface:

| Surface | When | What the stage runs |
|---|---|---|
| `engine` | the change is in how a run behaves: `src/engine`, `src/kinds`, `src/adapters`, `src/watch`, `src/events` | a fake run in a demo repository, its `.sail/fake/` seeded to reproduce the ticket's scenario |
| `cli` | a command's arguments or output change: `src/cli` | the command in a demo repository |
| `dashboard` | what the dashboard draws or serves changes: `src/dashboard` | the dashboard in headless Chrome, over a demo repository's runs |
| `none` | nothing a user runs changes: a refactor, types, docs, tests alone | nothing |

A demo repository is a scratch git repository holding the fixture repository's `.sail/` (`test/fixtures/repo/.sail/`,
the `ticket-to-pr` workflow on fake ports, with `FAKE-1` seeded) or a `.sail/` of the stage's own making, every port on
`fake`, and this branch's `sail` on the `PATH`. When a change shows on more than one surface, pick the one closest to
the user: a new command's engine work is shown by running the command.

For each acceptance criterion, write one bullet: the scenario to set up (the seeds, the command, the view) and what to
observe, exact enough to check without judgment: an exit code, an event type and its field, an output line, the text
an element shows. For `none`, write why nothing can be shown, and submit that reason.

The stage runs each scenario as `sail` commands, one at a time and in the foreground, through a harness that captures
their output itself. There is no shell: no pipe, no redirect, no command in the background, no second command while the
first runs. A criterion that needs one, such as `sail … | head -1`, or a `sail stop` while `sail watch` runs, can't be
shown: give it no bullet, and name the test that observes it in its task's Evidence.

Every scenario runs sail, never a test: validation has run the tests already, and the stage can't run them. A criterion
about a fake's behaviour is shown through a fake run that exercises it, its answer seeded in `.sail/fake/`. A criterion
only a test can observe, such as a test rewritten or added, gets no bullet.

## 5. Submit

Submit the plan's slug (kebab-case, a few words), the Conventional Commits scope its commits share, its risk, and its
tasks, each with its id, title, type and suggested commit, matching the plan's Tasks list.

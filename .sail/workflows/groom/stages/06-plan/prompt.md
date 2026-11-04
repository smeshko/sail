Write an implementation plan for the change the ticket asks for, so the factory can implement it with no planning of its
own. You only plan: read the code, never change it.

## 1. Explore

Gather enough context to plan without guessing:

- Read the brief at `{{brief}}` in full: the ticket, its acceptance criteria and its comments. A `## Rulings` section
  in its description holds a person's answers to questions an earlier grooming asked: follow them.
- Read the grooming report at `{{report}}`: what grooming verified about the ticket, and under `## Assumptions` the
  choices it made on open points. Plan on those choices unless the code shows one wrong, and say so in Decisions.
- `$STAGE_IN/actions.json` lists what grooming applies to the ticket. An `edit` replaces its title or description, and a
  `merge` whose `into` is this ticket replaces its description with the merged one: plan the ticket as they leave it.
- `docs/` holds a local copy of the design docs: ADRs in `docs/adr/`, plans and their decisions in
  `docs/artifacts/plans/`. Cite a decision there by its number rather than deciding the point again.
- Locate the entry points, types, modules and tests the change touches, under `src/` and `test/`. Follow imports and
  calls far enough to see how the pieces connect. Read `CONTEXT.md` for the terms to use.
- Check recent history for related changes: `git log --oneline -20`.
- Note the files likely to change, the patterns to follow, the constraints, and what is still uncertain.

You read and never run: not the tests, not the gate, and no scratch file outside `$STAGE_OUT`. Reason from the code
and the tests as written: the tests take minutes, and validation runs them after implement.

## 2. Resolve what you can, ask what you can't

No one answers questions during this run. Settle each open point from the ticket, the code and the conventions, and
record it as a Decision. Where two approaches exist, reason through both, pick one and record why.

Ask only when a guess would plan the wrong change: the ticket's goal or its acceptance is unclear, or a choice changes
what a user sees and neither the code nor the docs settle it. Submit such points as `questions`, **at most two**, the
ones a person most needs to answer. A question the Rulings or the report's Assumptions already answer is not open.

With questions, the plan is not attached: the ticket waits for the answers and is groomed again. Still complete the plan
on your recommended answers, since its sections are checked either way. A change that needs a path implement can't
write (below) is a question too: ask how the ticket should change.

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
  If the change needs any other path, ask about it as a question, naming the path: implement would block on it.
- Implement may add an npm dependency with `bun add --exact <package>`, and the task that first imports it adds it.
  A program installed on the machine is not one: CI has only what `package.json` and `bun.lock` name.

## 4. Plan the demonstration

Once the factory's pull request is open, the review workflow shows the change working the way a user would see it, and checks it
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

Submit `questions` too, an empty list when you settled everything. Each one has:

- `ask`: the question, containing a `?`
- `options`: two to four, each with the `option` (a short name) and what choosing it `means` day to day
- `recommend`: the text of one option, exactly as in `options`, the one the plan assumes
- `why`: why you recommend it
- `cites`: at least one `file:line` (or `file:line-line`) in the repository that your recommendation rests on

A question that breaks one of these, or a third question, is rejected and you must submit again.

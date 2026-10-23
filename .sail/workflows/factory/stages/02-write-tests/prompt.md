Write every test the plan at `{{plan}}` needs, and the stubs they call, before any implementation exists. The tests
land pending, each behind a sticker that keeps it skipped until its task starts. From then on the tests are the
contract: implementation makes them pass through production code and never edits them.

{{#if feedback}}
## The last attempt failed its proof

`$STAGE_IN/feedback.json` holds what proving your tests found: each problem, and the tests that went red. Your tests
and stubs from the last attempt are still in the working tree. Fix what the problems name, and keep the rest.

{{/if}}
## 1. Design the tests

Read the plan in full. For each `impl` task, map every Acceptance item to the fewest tests that prove it:

- A behaviour: tests named for the behaviour, each asserting an exact value.
- A behaviour change existing tests already cover: those tests, updated to the new expectation.
- A pure refactor: no new tests; the existing suite staying green proves it.
- An item only a transcript or a log can prove: no test; it stays Evidence for implementation.

Every test is **non-vacuous**: break the behaviour it claims (revert the change, flip a condition, return a constant)
and it goes red. For each test, name to yourself a concrete regression it catches, and check the test's input actually
triggers it and its assertion actually fails on it. Hunt these smells and remove them:

- asserting on a mock the test configured itself, or an expected value computed with the code under test;
- weak assertions (not-null, doesn't throw) where the exact value was knowable;
- loops or tables over an empty collection; an async test that never awaits; a broad catch.

Every test is **tight**: one per acceptance behaviour, plus one per branch that breaks independently (a boundary, an
error path). Test through the public surface the plan names, run real code wherever you can, and name each test after
the behaviour it proves.

## 2. Write the stubs

Every new symbol a test calls gets its final signature and final types, and a body that returns a **wrong value of the
right type**, chosen so every test fails on its assertion: a filter stub returns its input unfiltered. Stubs return;
they never throw, since a crash is not a red assertion. Existing symbols keep their current behaviour: for a changed
behaviour, the current one is the wrong value. A schema the tests need takes its final type and its old parse. If
`src/sdk` changes, run `bun run types`.

## 3. Write the tests

Follow `test/`'s layout and style: `test/cli/run.test.ts` tests `src/cli/index.ts`, and anything touching git or
`HOME` runs inside `withTempRepo()`. Every new or changed test gets one sticker for its task, on two lines, both
tagged:

```ts
// biome-ignore format: TDD-PENDING TASK-002
test
  .skip // TDD-PENDING TASK-002
  ('rejects a branch that is leased elsewhere', async () => {
    …
  });
```

- It works with `test.skip.each(…)` and `test.skip.skipIf(…)` too. A table whose rows go red and green on the stubs
  can't share one sticker: split it.
- Write test names single-quoted unless they hold an apostrophe: Biome requotes them once the sticker goes, and that
  edit would break the lock.
- Everything under `test/` is locked when the tests commit lands, helpers and fixtures included. Land helpers complete,
  and make any fixture change (a golden file, a seed) now.
- Bun's `toEqual` is typed: compare against the stubs' final types, or through `toMatchObject` or text.
- A negative guard ("emits nothing on X") can't be red against a stub: fold it into a positive test of the same
  behaviour.
- When the plan changes one assertion of an existing test, keep the rest of that test running: move the assertion
  into a new pending test rather than stickering the whole test.

Don't strip stickers or commit: proving them red is the next step's job, and it reports back to you if any fail to.

## 4. Check before you submit

- `bun run typecheck` and `bun run lint` pass (`bun run fix` formats).
- `bun run test <your test files>` passes, with every stickered test skipped.

## 5. Submit

Submit every pending test case: its task, its file, and its name exactly as written (a `.each` title with its `%s`
left in). When the plan needs no new test, submit no cases and say why in `none`.

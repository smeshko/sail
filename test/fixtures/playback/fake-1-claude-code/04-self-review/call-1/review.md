# Review: add a `--shout` flag to `greet`

## Findings

1. **low**: `src/cli.ts`: the name is "the first argument that isn't `--shout`", but the spec says "first non-flag".
   Task 2 says to take "the first remaining argument that isn't a flag as the name". The code uses
   `args.find((arg) => arg !== '--shout')`, so an unknown flag becomes the name. For example,
   `greet --loud Ada` prints `Hello, --loud!`. A check like `!arg.startsWith('-')` would match the spec's
   wording. No test covers this case.

2. **low**: `src/cli.ts`: `--help` is now recognised anywhere in the arguments, not only as the first one.
   Before, `greet Ada --help` printed `Hello, Ada!`. Now it prints the usage line. The spec doesn't ask for
   this change. It is arguably an improvement and is consistent with how `--shout` is handled, but it changes
   existing behaviour that the spec says should stay the same. It should either be noted in the PR or be
   reverted to an `args[0] === '--help'` check.

3. **nit**: `test/greet.test.ts`: `defaults to not shouting` repeats the existing `greets a name` test word for word
   (`greet('Ada')` → `Hello, Ada!`). The spec asked for it, so it is harmless, but it adds no coverage.
   `greet('Ada', { shout: false })` would test the explicit-off path instead.

4. **nit**: workspace: an untracked, empty file `test/_tmp-sha.test.ts` is in the working tree. It is not part of
   any commit, but it should be deleted so it isn't picked up by `git add -A` or the test runner.

The other requirements are met. `greet()` takes an optional `{ shout?: boolean }` that defaults to off, and the
whole greeting, name included, is upper-cased. Trimming and the `world` fallback are unchanged because the
upper-casing happens after them. The CLI accepts `--shout` before or after the name. The help text reads
`usage: greet [name] [--shout]`. All the unit and CLI tests the spec lists are present, and the help test was
updated. I could not run `bun test` in this step because the command is not permitted here, so I checked the
test expectations by reading the code, not by running it.

## Verdict

The change meets the spec. It is small and clean, its three commits match the three tasks, and every test the
spec asks for is in place. Nothing blocks the pull request. The two low findings are small deviations from the
spec's wording. Name selection skips only `--shout`, not all flags. `--help` now works in any position, which
changes existing behaviour. Both are worth a one-line fix or a note in the PR. The nits are cosmetic. Approve,
preferably with finding 1 fixed and the stray temp file removed.

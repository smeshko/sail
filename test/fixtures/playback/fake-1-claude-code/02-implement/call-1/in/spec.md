# Spec

## Requirements

- `bun src/cli.ts Ada --shout` prints `HELLO, ADA!` followed by a newline. The whole greeting is upper-cased, the name included, and the flag is accepted before or after the name (`greet --shout Ada` prints the same).
- `bun src/cli.ts Ada` without the flag still prints `Hello, Ada!` followed by a newline, and the existing behaviour (trimming, `Hello, world!` for a blank or missing name) is unchanged.
- `bun src/cli.ts --help` prints a usage line that lists `--shout`, for example `usage: greet [name] [--shout]`.

## Tasks

1. Add an optional `shout` option to `greet()` that upper-cases the whole greeting, defaulting to off so current callers are unaffected. Add unit tests for `greet('Ada', { shout: true })` returning `HELLO, ADA!`, for the blank-name case returning `HELLO, WORLD!`, and for the default staying `Hello, Ada!`. Files: `src/greet.ts`, `test/greet.test.ts`.
2. Make the CLI recognise `--shout` anywhere in the arguments, take the first remaining argument that isn't a flag as the name, and pass `shout` through to `greet()`. Add CLI tests for `Ada --shout` → `HELLO, ADA!\n`, `--shout Ada` → `HELLO, ADA!\n` and `Ada` → `Hello, Ada!\n`. Files: `src/cli.ts`, `test/cli.test.ts`.
3. Change the `--help` usage text to list `--shout` (`usage: greet [name] [--shout]`) and update the existing help test to match. Files: `src/cli.ts`, `test/cli.test.ts`.

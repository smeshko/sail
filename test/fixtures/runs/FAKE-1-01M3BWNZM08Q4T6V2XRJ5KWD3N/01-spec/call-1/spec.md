# Spec: Add a --shout flag to the greet command

## Requirements

- `greet(name, { shout: true })` returns the whole greeting in upper case, the name included.
- Without the option, `greet` behaves exactly as before.
- `greet --help` lists `--shout`.

## Tasks

1. Add the shout option to greet() and the --shout flag to the CLI (`src/greet.ts`, `src/cli.ts`)
2. Cover --shout and its help text in tests (`test/greet.test.ts`)

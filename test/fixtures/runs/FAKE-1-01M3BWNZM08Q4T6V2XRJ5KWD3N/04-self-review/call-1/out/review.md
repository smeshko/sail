# Review: FAKE-1

## Findings

- **low**, `src/cli.ts`: Unknown flags are treated as missing names. An argument such as --loud is skipped rather than reported.
- **nit**, `test/greet.test.ts`: Test names could mention the option. The shout tests could say "{ shout: true }" to match the spec.

## Verdict

The change meets the spec. Two minor findings, nothing that blocks.

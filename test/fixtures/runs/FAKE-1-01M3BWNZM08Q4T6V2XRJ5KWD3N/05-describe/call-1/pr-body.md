## Summary

Adds `--shout` to the `greet` command: with it, the whole greeting is printed in upper case.

## Changes

- `greet()` takes `{ shout }` and upper-cases the whole line.
- The CLI reads `--shout`, and `--help` lists it.
- Tests cover both, plus the help text.

## Testing

`bun test`: 7 of 7 pass.

Ticket: FAKE-1

## Summary

Adds a `--shout` flag to the `greet` CLI so the greeting can be printed upper-cased, in addition to its normal form.

## Changes

- Added an optional `shout` option to `greet()` that upper-cases the whole greeting, defaulting to off so existing callers are unaffected.
- Updated the CLI to recognise `--shout` anywhere in its arguments, take the first remaining non-flag argument as the name, and pass `shout` through to `greet()`.
- Updated the `--help` usage text to list the new flag (`usage: greet [name] [--shout]`).

## Testing

- Added unit tests for `greet('Ada', { shout: true })` returning `HELLO, ADA!`, the blank-name case returning `HELLO, WORLD!`, and the default staying `Hello, Ada!`.
- Added CLI tests for `Ada --shout` and `--shout Ada` both printing `HELLO, ADA!\n`, and `Ada` printing `Hello, Ada!\n`.
- Updated the existing help test to match the new usage text.

Ticket: [FAKE-1](fake://tickets/FAKE-1)

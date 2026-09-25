# Brief: FAKE-1

## Request

<untrusted-input source="ticket FAKE-1, description">
Add a `--shout` flag to the `greet` command. With the flag, the whole greeting is printed in upper case.
</untrusted-input>

## Acceptance criteria

<untrusted-input source="ticket FAKE-1, acceptance criteria">
- `greet Ada --shout` prints `HELLO, ADA!`
- `greet Ada` still prints `Hello, Ada!`
- `greet --help` lists `--shout`
</untrusted-input>

## Context

- Ticket: FAKE-1, "Add a --shout flag to the greet command" (fake://tickets/FAKE-1)
- Labels: sail
- Comments: 1

<untrusted-input source="ticket FAKE-1, comment 1">
Upper-case the whole line, the name included.
</untrusted-input>

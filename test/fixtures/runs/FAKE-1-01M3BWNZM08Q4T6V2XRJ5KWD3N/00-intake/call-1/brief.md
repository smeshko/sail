# Brief: FAKE-1

## Request

<untrusted-input source="ticket FAKE-1, title">
Add a --shout flag to the greet command
</untrusted-input>

<untrusted-input source="ticket FAKE-1, description">
Add a `--shout` flag to the `greet` command. With the flag, the whole greeting is printed in upper case.
</untrusted-input>

## Acceptance criteria

- <untrusted-input source="ticket FAKE-1, acceptance criterion 1">`greet Ada --shout` prints `HELLO, ADA!`</untrusted-input>
- <untrusted-input source="ticket FAKE-1, acceptance criterion 2">`greet Ada` still prints `Hello, Ada!`</untrusted-input>
- <untrusted-input source="ticket FAKE-1, acceptance criterion 3">`greet --help` lists `--shout`</untrusted-input>

## Context

- Ticket: FAKE-1
- URL: <untrusted-input source="ticket FAKE-1, url">fake://tickets/FAKE-1</untrusted-input>
- State: started
- Labels:
  - <untrusted-input source="ticket FAKE-1, label 1">sail</untrusted-input>

### Comments

<untrusted-input source="ticket FAKE-1, comment 1 author">fixture-user</untrusted-input> wrote:

<untrusted-input source="ticket FAKE-1, comment 1">
Upper-case the whole line, the name included.
</untrusted-input>

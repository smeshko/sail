# Brief: {{ticket.ticketKey}}

## Request

{{ticket.description}}

## Acceptance criteria

{{#each ticket.acceptanceCriteria}}
- {{this}}
{{/each}}

## Context

- Ticket: {{ticket.ticketKey}}, "{{ticket.title}}" ({{ticket.url}})
{{#if ticket.comments}}

## Comments
{{#each ticket.comments}}

**{{author}}** ({{at}}) on {{ticket.ticketKey}}:

{{body}}
{{/each}}
{{else}}
- No comments.
{{/if}}

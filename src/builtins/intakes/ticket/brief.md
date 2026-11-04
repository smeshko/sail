# Brief: {{ticket.key}}

## Request

{{ticket.title}}
{{#if ticket.request}}

{{ticket.request}}
{{/if}}

## Acceptance criteria

{{#if criteria}}
{{#each criteria}}
- {{this}}
{{/each}}
{{else}}
None stated.
{{/if}}

## Context

- Ticket: {{ticket.key}}
- URL: {{ticket.url}}
- State: {{ticket.state}}
{{#if labels}}
- Labels:
{{#each labels}}
  - {{this}}
{{/each}}
{{/if}}
{{#if links}}
- Links:
{{#each links}}
  - {{url}}{{#if title}} ({{title}}){{/if}}
{{/each}}
{{/if}}
{{#if attachments}}
- Attachments:
{{#each attachments}}
  - {{name}}: {{url}}{{#if path}} (downloaded to {{path}}, beside this brief){{/if}}{{#if skipped}} ({{skipped}}){{/if}}
{{/each}}
{{/if}}
{{#if comments}}

### Comments
{{#each comments}}

{{author}} wrote:

{{body}}
{{/each}}
{{else}}
- Comments: none
{{/if}}

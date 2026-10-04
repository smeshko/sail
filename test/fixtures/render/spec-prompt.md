Write the spec for {{ticket.ticketKey}}: {{ticket.title}}.

Read the brief at `{{in.brief}}` and the ticket at `{{in.ticket}}`.

{{#if feedback}}
Fix what the last review reported first: {{feedback}}
{{else}}
There is no earlier feedback, so start from the brief.
{{/if}}

Cover each acceptance criterion:
{{#each ticket.acceptanceCriteria}}
- {{this}}
{{/each}}

Write the spec to `{{out.spec}}`, with these sections:

{{goal: one paragraph}}

{{tasks: a numbered list, each with its files}}

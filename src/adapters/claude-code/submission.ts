// How a Claude Code session submits (D2). The session's structured output is an envelope that says `done`, with the
// step's output, or `blocked`, with a reason, so the agent can submit the outcome its prompt promises. The adapter reads
// the envelope back; the agent kind checks the output against the step's schema again, so nothing here validates it.

/** The text appended to the preset system prompt: how this harness takes a submission. */
export const SUBMIT_CONTRACT = `## Submitting

You submit through structured output, exactly once, when the work is over. The object you submit is an envelope:

- When the work is complete: {"outcome": "done", "output": <the output its schema describes>}
- When you cannot complete it: {"outcome": "blocked", "reason": "<one paragraph saying why>"}

Submit nothing else, and do not submit before the work is done.`;

/**
 * The JSON Schema the session submits against: the envelope, with `schema` as its `output`. The step schema's own
 * definitions move to the envelope's root, so a `#/definitions/…` or `#/$defs/…` reference inside it still resolves.
 */
export function submissionEnvelope(outputSchema: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const { $schema: _schema, definitions, $defs, ...output } = outputSchema;
  return {
    type: 'object',
    properties: {
      outcome: { enum: ['done', 'blocked'] },
      output,
      reason: { type: 'string' },
    },
    required: ['outcome'],
    additionalProperties: false,
    ...(definitions === undefined ? {} : { definitions }),
    ...($defs === undefined ? {} : { $defs }),
  };
}

/** What a submission said: done with its output, blocked with its reason, or why it can't be read. */
export type Submission =
  | { readonly outcome: 'done'; readonly output: unknown }
  | { readonly outcome: 'blocked'; readonly reason: string }
  | { readonly unreadable: string };

/** What `value` is, in a few words, for a message. */
function kindOf(value: unknown): string {
  if (value === null || value === undefined) return String(value);
  if (Array.isArray(value)) return 'an array';
  return `a ${typeof value}`;
}

/** Reads the session's structured output back as a submission. */
export function readSubmission(structured: unknown): Submission {
  if (typeof structured !== 'object' || structured === null || Array.isArray(structured)) {
    return { unreadable: `the submission is ${kindOf(structured)}, not an envelope` };
  }
  const envelope = structured as { outcome?: unknown; output?: unknown; reason?: unknown };
  if (envelope.outcome === 'done') return { outcome: 'done', output: envelope.output };
  if (envelope.outcome === 'blocked') {
    return { outcome: 'blocked', reason: typeof envelope.reason === 'string' ? envelope.reason : '' };
  }
  return {
    unreadable: `the submission's outcome is ${JSON.stringify(envelope.outcome) ?? 'missing'}, not done or blocked`,
  };
}

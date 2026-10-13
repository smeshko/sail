// The submit contract's envelope: the SDK's structured output is a `done` or a `blocked` branch around the step's own
// schema. The agent kind still validates the unwrapped output against the step's Zod schema, so a `done` whose output
// is wrong takes the agent kind's corrective try.

/** The two ways a session submits, as the envelope unwraps them. */
export type Submission =
  | { readonly outcome: 'done'; readonly output: unknown }
  | { readonly outcome: 'blocked'; readonly reason: string };

/** Where the step schema sits in the envelope: the `done` branch's `output`. Local references are relative to the root. */
const OUTPUT_POINTER = '#/oneOf/0/properties/output';

/** The step schema with each local `$ref` pointed where the schema now sits, so `#` and `#/…` still reach it (review #1.4). */
function rebase(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(rebase);
  if (typeof node !== 'object' || node === null) return node;
  return Object.fromEntries(
    Object.entries(node).map(([key, value]) => [
      key,
      key === '$ref' && typeof value === 'string' && value.startsWith('#')
        ? OUTPUT_POINTER + value.slice(1)
        : rebase(value),
    ]),
  );
}

/** The draft-07 JSON Schema the SDK receives as `outputFormat.schema`: one branch per outcome, and no other shape. */
export function submissionSchema(outputSchema: Readonly<Record<string, unknown>>): Record<string, unknown> {
  return {
    type: 'object',
    oneOf: [
      {
        type: 'object',
        properties: { outcome: { const: 'done' }, output: rebase(outputSchema) },
        required: ['outcome', 'output'],
        additionalProperties: false,
      },
      {
        type: 'object',
        properties: { outcome: { const: 'blocked' }, reason: { type: 'string', pattern: '\\S' } },
        required: ['outcome', 'reason'],
        additionalProperties: false,
      },
    ],
  };
}

/** What a structured output submitted, or nothing when it is not a well-formed envelope. */
export function unwrap(envelope: unknown): Submission | undefined {
  if (typeof envelope !== 'object' || envelope === null) return undefined;
  const fields = envelope as Readonly<Record<string, unknown>>;
  if (fields.outcome === 'done' && fields.output !== undefined) return { outcome: 'done', output: fields.output };
  if (fields.outcome === 'blocked' && typeof fields.reason === 'string' && fields.reason.trim() !== '') {
    return { outcome: 'blocked', reason: fields.reason };
  }
  return undefined;
}

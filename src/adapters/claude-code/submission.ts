// How a Claude Code session submits (D2). The session's structured output is an envelope that says `done`, with the
// step's output, or `blocked`, with a reason, so the agent can submit the outcome its prompt promises. The adapter reads
// the envelope back; the agent kind checks the output against the step's schema again, so nothing here validates it.

/** The text appended to the preset system prompt: how this harness takes a submission. */
export const SUBMIT_CONTRACT = `## Submitting

You submit through structured output, exactly once, when the work is over. The object you submit is an envelope:

- When the work is complete: {"outcome": "done", "output": <the output its schema describes>}
- When you cannot complete it: {"outcome": "blocked", "reason": "<one paragraph saying why>"}

Submit nothing else, and do not submit before the work is done.`;

/** Keywords whose values are data, not schemas: a `$ref` inside them is no reference. */
const DATA_KEYWORDS = new Set(['const', 'enum', 'default', 'examples']);

/** Keywords whose values map names to schemas: a name there is no keyword, whatever it reads. */
const NAMED_SCHEMAS = new Set(['properties', 'patternProperties', 'definitions', '$defs', 'dependencies']);

/** Where the step schema's root sits in the envelope. */
const OUTPUT_POINTER = '#/properties/output';

/** A `$ref` to the step schema's root resource as the local pointer it names, or undefined when it names another. */
function localOf(ref: string, rootId: string | undefined): string | undefined {
  if (ref.startsWith('#')) return ref;
  if (rootId === undefined || !ref.startsWith(rootId)) return undefined;
  const fragment = ref.slice(rootId.length);
  if (fragment === '') return '#';
  return fragment.startsWith('#') ? fragment : undefined;
}

/** `ref`, a reference inside the step schema's root resource, as it resolves from the envelope. */
function rebasedRef(ref: string, rootId: string | undefined): string {
  const local = localOf(ref, rootId);
  if (local === undefined) return ref;
  if (local === '#' || local === '#/') return OUTPUT_POINTER;
  if (local.startsWith('#/definitions/') || local.startsWith('#/$defs/')) return local;
  return local.startsWith('#/') ? OUTPUT_POINTER + local.slice(1) : ref;
}

/**
 * `node` with every reference into the step schema's root resource rebased onto the envelope's `output`: `#` (Zod's
 * reference to a recursive schema's root), any `#/…` pointer but the hoisted `#/definitions/…` and `#/$defs/…`, and
 * the same written absolutely through the root's `$id`. A schema below the root with a `$id` of its own is a resource
 * whose local references mean it, so it is left as it is.
 */
function rebased(node: unknown, rootId: string | undefined, names = false, root = false): unknown {
  if (Array.isArray(node)) return node.map((item) => rebased(item, rootId));
  if (typeof node !== 'object' || node === null) return node;
  if (!names && !root && '$id' in node) return node;
  return Object.fromEntries(
    Object.entries(node).map(([key, value]) => {
      if (names) return [key, rebased(value, rootId)];
      if (key === '$ref' && typeof value === 'string') return [key, rebasedRef(value, rootId)];
      return [key, DATA_KEYWORDS.has(key) ? value : rebased(value, rootId, NAMED_SCHEMAS.has(key))];
    }),
  );
}

/**
 * The JSON Schema the session submits against: the envelope, with `schema` as its `output`. The step schema's own
 * definitions move to the envelope's root, so a `#/definitions/…` or `#/$defs/…` reference inside it still resolves, and
 * every other local reference is rebased onto `output`. Its `$id` moves to the root too, since the references now
 * resolve against the envelope.
 */
export function submissionEnvelope(outputSchema: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const rootId = typeof outputSchema.$id === 'string' ? outputSchema.$id.replace(/#$/, '') : undefined;
  const rebasedSchema = rebased(outputSchema, rootId, false, true) as Record<string, unknown>;
  const { $schema: _schema, $id, definitions, $defs, ...output } = rebasedSchema;
  return {
    ...($id === undefined ? {} : { $id }),
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

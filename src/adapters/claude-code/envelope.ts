// The submit contract's envelope: the SDK's structured output is a `done` or a `blocked` branch around the step's own
// schema. The agent kind still validates the unwrapped output against the step's Zod schema, so a `done` whose output
// is wrong takes the agent kind's corrective try.

/** The two ways a session submits, as the envelope unwraps them. */
export type Submission =
  | { readonly outcome: 'done'; readonly output: unknown }
  | { readonly outcome: 'blocked'; readonly reason: string };

/** Where the step schema sits in the envelope: the `done` branch's `output`. Local references are relative to the root. */
const OUTPUT_POINTER = '#/oneOf/0/properties/output';

// The keywords whose values are schemas, by shape: a map of schemas, one schema, or a list of schemas. Any other keyword
// holds data (const, enum, default, examples, required, ...) and is copied as it is (review #2.2).
const SCHEMA_MAPS = ['properties', 'patternProperties', 'definitions', '$defs', 'dependentSchemas'];
const SCHEMA_ONES = [
  'additionalItems',
  'additionalProperties',
  'contains',
  'contentSchema',
  'else',
  'if',
  'not',
  'propertyNames',
  'then',
  'unevaluatedItems',
  'unevaluatedProperties',
];
const SCHEMA_LISTS = ['allOf', 'anyOf', 'oneOf', 'prefixItems'];

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * The step schema with each local `$ref` pointed where the schema now sits, so `#` and `#/…` still reach it (review #1.4).
 * A subschema with its own `$id` opens a new scope, so its references are left as they are, and data is never rewritten.
 * An empty `$id` or a bare fragment (`#name`) opens no scope (review #3.2). A named fragment is not a JSON pointer, so
 * only `#` and `#/…` are rebased.
 */
function rebase(schema: unknown): unknown {
  const opensScope =
    isObject(schema) && typeof schema.$id === 'string' && schema.$id !== '' && !schema.$id.startsWith('#');
  if (!isObject(schema) || opensScope) return schema;
  const rebaseList = (list: unknown) => (Array.isArray(list) ? list.map(rebase) : list);
  const rebaseMap = (map: unknown) =>
    isObject(map) ? Object.fromEntries(Object.entries(map).map(([name, sub]) => [name, rebase(sub)])) : map;
  return Object.fromEntries(
    Object.entries(schema).map(([key, value]) => {
      if (key === '$ref' && typeof value === 'string' && (value === '#' || value.startsWith('#/'))) {
        return [key, OUTPUT_POINTER + value.slice(1)];
      }
      if (SCHEMA_MAPS.includes(key)) return [key, rebaseMap(value)];
      if (SCHEMA_LISTS.includes(key)) return [key, rebaseList(value)];
      if (key === 'items') return [key, Array.isArray(value) ? rebaseList(value) : rebase(value)];
      if (key === 'dependencies' && isObject(value)) {
        return [key, rebaseMap(value)];
      }
      if (SCHEMA_ONES.includes(key)) return [key, rebase(value)];
      return [key, value];
    }),
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

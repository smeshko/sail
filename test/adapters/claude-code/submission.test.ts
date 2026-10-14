// The claude-code submission (D2): the envelope the session submits against, reading it back, and the submit contract
// appended to its system prompt.
import { expect, test } from 'bun:test';
import Ajv from 'ajv';
import { z } from 'zod';
import { readSubmission, SUBMIT_CONTRACT, submissionEnvelope } from '../../../src/adapters/claude-code/submission';

/** `value` and everything in it, frozen. */
function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null) {
    for (const member of Object.values(value)) deepFreeze(member);
    Object.freeze(value);
  }
  return value;
}

const Task = z.object({ title: z.string() }).meta({ id: 'ClaudeCodeSubmissionTask' });
const Spec = z.object({ summary: z.string(), first: Task, rest: z.array(Task) });

test('the envelope is a plain object of outcome, output and reason, with only outcome required, and the step schema as output', () => {
  const step = deepFreeze({ type: 'object', properties: { summary: { type: 'string' } }, required: ['summary'] });
  expect(submissionEnvelope(step)).toEqual({
    type: 'object',
    properties: {
      outcome: { enum: ['done', 'blocked'] },
      output: { type: 'object', properties: { summary: { type: 'string' } }, required: ['summary'] },
      reason: { type: 'string' },
    },
    required: ['outcome'],
    additionalProperties: false,
  });
});

test("a step schema's $schema is dropped and its definitions hoisted, so its refs resolve: Ajv takes a done envelope and refuses bad output", () => {
  const step = deepFreeze(z.toJSONSchema(Spec, { target: 'draft-07', io: 'input' }) as Record<string, unknown>);
  expect(JSON.stringify(step)).toContain('"$ref":"#/definitions/ClaudeCodeSubmissionTask"');
  const envelope = submissionEnvelope(step);
  const output = (envelope.properties as Record<string, Record<string, unknown>>).output ?? {};
  expect({ root: Object.keys(envelope).sort(), output: Object.keys(output).sort() }).toEqual({
    root: ['additionalProperties', 'definitions', 'properties', 'required', 'type'],
    output: ['properties', 'required', 'type'],
  });
  const validate = new Ajv({ strict: false }).compile(envelope);
  const spec = { summary: 'Add a flag.', first: { title: 'Flag' }, rest: [{ title: 'Tests' }] };
  const verdicts = [
    validate({ outcome: 'done', output: spec }),
    validate({ outcome: 'done', output: { ...spec, rest: [{ title: 3 }] } }),
    validate({ outcome: 'blocked', reason: 'No acceptance criteria.' }),
    validate({ outcome: 'error' }),
  ];
  expect(verdicts).toEqual([true, false, true, false]);
});

// Review R1-5: Zod writes a recursive output's reference to itself as `#`, which inside the envelope would mean the
// envelope. Such references are rebased onto the output, and a definition's are too.
test("a recursive output's references to its own root are rebased onto the output, so a tree validates", () => {
  const Node: z.ZodType<{ name: string; children?: unknown[] | undefined }> = z.object({
    name: z.string(),
    get children() {
      return z.array(Node).optional();
    },
  });
  const step = deepFreeze(z.toJSONSchema(Node, { target: 'draft-07', io: 'input' }) as Record<string, unknown>);
  expect(JSON.stringify(step)).toContain('"$ref":"#"');
  const nested = deepFreeze({
    type: 'object',
    properties: {
      tree: { $ref: '#/definitions/T' },
      other: { $ref: '#/properties/tree' },
      default: { $ref: '#' },
      fixed: { const: { $ref: '#' } },
    },
    definitions: { T: { type: 'object', properties: { up: { $ref: '#' } } } },
  });
  const tree = { name: 'root', children: [{ name: 'leaf', children: [] }] };
  const validate = new Ajv({ strict: false }).compile(submissionEnvelope(step));
  expect({
    tree: validate({ outcome: 'done', output: tree }),
    badLeaf: validate({ outcome: 'done', output: { name: 'root', children: [{ name: 3 }] } }),
    nested: JSON.stringify(submissionEnvelope(nested)),
  }).toEqual({
    tree: true,
    badLeaf: false,
    nested: JSON.stringify({
      type: 'object',
      properties: {
        outcome: { enum: ['done', 'blocked'] },
        output: {
          type: 'object',
          properties: {
            tree: { $ref: '#/definitions/T' },
            other: { $ref: '#/properties/output/properties/tree' },
            default: { $ref: '#/properties/output' },
            fixed: { const: { $ref: '#' } },
          },
        },
        reason: { type: 'string' },
      },
      required: ['outcome'],
      additionalProperties: false,
      definitions: { T: { type: 'object', properties: { up: { $ref: '#/properties/output' } } } },
    }),
  });
});

// Review R2-1: a `$id` starts a resource of its own, which a `#` inside it means. The root's `$id` moves to the envelope
// with the definitions, so the rebased references resolve against it, and a nested resource is left as it is.
test("a recursive output with a $id validates in the envelope, and a nested resource's references are its own", () => {
  const Node: z.ZodType<{ name: string; children?: unknown[] | undefined }> = z
    .object({
      name: z.string(),
      get children() {
        return z.array(Node).optional();
      },
    })
    .meta({ $id: 'https://example.test/tree' });
  const step = deepFreeze(z.toJSONSchema(Node, { target: 'draft-07', io: 'input' }) as Record<string, unknown>);
  expect(JSON.stringify(step)).toContain('"$ref":"#"');
  const envelope = submissionEnvelope(step);
  const validate = new Ajv({ strict: false }).compile(envelope);
  const nested = submissionEnvelope(
    deepFreeze({
      type: 'object',
      properties: { list: { $id: 'https://example.test/list', type: 'array', items: { $ref: '#' } } },
    }),
  );
  expect({
    id: envelope.$id,
    tree: validate({ outcome: 'done', output: { name: 'root', children: [{ name: 'leaf' }] } }),
    badLeaf: validate({ outcome: 'done', output: { name: 'root', children: [{ name: 3 }] } }),
    list: (nested.properties as Record<string, unknown>).output,
  }).toEqual({
    id: 'https://example.test/tree',
    tree: true,
    badLeaf: false,
    list: {
      type: 'object',
      properties: { list: { $id: 'https://example.test/list', type: 'array', items: { $ref: '#' } } },
    },
  });
});

// Review R3-1, and a property after three rounds of findings here: whatever a step schema's references look like, the
// envelope takes a done submission exactly when the step schema takes its output. Ajv on the step schema is the
// reference; the values are a seeded random mix of trees, specs and stray shapes.
test('over seeded random values, a done envelope validates exactly when the step schema validates its output', () => {
  const U = 'https://example.test/tree';
  const Recursive: z.ZodType<{ name: string; children?: unknown[] | undefined }> = z.object({
    name: z.string(),
    get children() {
      return z.array(Recursive).optional();
    },
  });
  const Identified: z.ZodType<{ name: string; children?: unknown[] | undefined }> = z
    .object({
      name: z.string(),
      get children() {
        return z.array(Identified).optional();
      },
    })
    .meta({ $id: U });
  const zod = (schema: z.ZodType) => z.toJSONSchema(schema, { target: 'draft-07', io: 'input' });
  const schemas: Record<string, Record<string, unknown>> = {
    recursive: zod(Recursive),
    identified: zod(Identified),
    spec: zod(Spec),
    absoluteSelf: {
      $id: U,
      type: 'object',
      properties: { name: { type: 'string' }, children: { type: 'array', items: { $ref: U } } },
      required: ['name'],
    },
    absoluteFragments: {
      $id: U,
      type: 'object',
      properties: {
        name: { $ref: `${U}#/definitions/text` },
        children: { type: 'array', items: { $ref: `${U}#` } },
        first: { $ref: `${U}#/properties/name` },
      },
      required: ['name'],
      definitions: { text: { type: 'string' } },
    },
    nestedResource: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        children: {
          $id: 'https://example.test/list',
          type: 'array',
          items: { anyOf: [{ type: 'string' }, { $ref: '#' }] },
        },
      },
      required: ['name'],
    },
  };

  let seed = 20261014;
  const random = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)] as T;
  const value = (depth: number): unknown => {
    const kind =
      depth <= 0 ? pick(['string', 'number']) : pick(['string', 'number', 'null', 'array', 'object', 'object']);
    if (kind === 'string') return pick(['a', 'root', '']);
    if (kind === 'number') return pick([0, 3]);
    if (kind === 'null') return null;
    if (kind === 'array') return Array.from({ length: Math.floor(random() * 3) }, () => value(depth - 1));
    const keys = ['name', 'children', 'summary', 'first', 'rest', 'title'].filter(() => random() < 0.5);
    return Object.fromEntries(keys.map((key) => [key, value(depth - 1)]));
  };
  const samples = [
    { name: 'root', children: [{ name: 'leaf', children: [] }, 'tip'] },
    { name: 'root', children: [{ name: 3 }] },
    { summary: 's', first: { title: 't' }, rest: [{ title: 'u' }] },
    ...Array.from({ length: 400 }, () => value(4)),
  ];

  const ajv = () => new Ajv({ strict: false });
  const mismatches: string[] = [];
  const accepted: Record<string, number> = {};
  for (const [name, schema] of Object.entries(schemas)) {
    const original = ajv().compile(schema);
    const wrapped = ajv().compile(submissionEnvelope(deepFreeze(structuredClone(schema))));
    accepted[name] = 0;
    for (const output of samples) {
      const expected = original(output);
      if (expected) accepted[name] += 1;
      if (wrapped({ outcome: 'done', output }) !== expected) mismatches.push(`${name}: ${JSON.stringify(output)}`);
    }
  }
  expect(mismatches).toEqual([]);
  // Each schema took some of the values, so the property is not vacuous.
  expect(Object.entries(accepted).filter(([, count]) => count === 0)).toEqual([]);
});

test('a $defs map is hoisted too, beside definitions', () => {
  const step = deepFreeze({
    type: 'object',
    properties: { a: { $ref: '#/$defs/A' }, b: { $ref: '#/definitions/B' } },
    $defs: { A: { type: 'string' } },
    definitions: { B: { type: 'number' } },
  });
  const envelope = submissionEnvelope(step);
  expect({ $defs: envelope.$defs, definitions: envelope.definitions }).toEqual({
    $defs: { A: { type: 'string' } },
    definitions: { B: { type: 'number' } },
  });
  const validate = new Ajv({ strict: false }).compile(envelope);
  expect([
    validate({ outcome: 'done', output: { a: 'x', b: 1 } }),
    validate({ outcome: 'done', output: { a: 1, b: 1 } }),
  ]).toEqual([true, false]);
});

test.each<[string, unknown, unknown]>([
  [
    'done with its output',
    { outcome: 'done', output: { summary: 'x' } },
    { outcome: 'done', output: { summary: 'x' } },
  ],
  ['done with 0', { outcome: 'done', output: 0 }, { outcome: 'done', output: 0 }],
  ['done with null', { outcome: 'done', output: null }, { outcome: 'done', output: null }],
  ['done with no output', { outcome: 'done' }, { outcome: 'done', output: undefined }],
  ['blocked with its reason', { outcome: 'blocked', reason: 'r' }, { outcome: 'blocked', reason: 'r' }],
  ['blocked with no reason', { outcome: 'blocked' }, { outcome: 'blocked', reason: '' }],
  ['undefined', undefined, { unreadable: 'the submission is undefined, not an envelope' }],
  ['null', null, { unreadable: 'the submission is null, not an envelope' }],
  ['a string', 'done', { unreadable: 'the submission is a string, not an envelope' }],
  ['an array', [{ outcome: 'done' }], { unreadable: 'the submission is an array, not an envelope' }],
  [
    'an outcome of error',
    { outcome: 'error' },
    { unreadable: `the submission's outcome is "error", not done or blocked` },
  ],
  ['no outcome', { output: 1 }, { unreadable: `the submission's outcome is missing, not done or blocked` }],
])('readSubmission reads %s', (_, structured, expected) => {
  expect(readSubmission(structured)).toEqual(expected as ReturnType<typeof readSubmission>);
});

test('the submit contract names both envelopes and says to submit exactly once', () => {
  expect({
    done: SUBMIT_CONTRACT.includes('"outcome": "done"'),
    blocked: SUBMIT_CONTRACT.includes('"outcome": "blocked"'),
    once: SUBMIT_CONTRACT.includes('exactly once'),
  }).toEqual({ done: true, blocked: true, once: true });
});

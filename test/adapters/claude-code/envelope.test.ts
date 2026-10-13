// The submit envelope: the SDK's structured output is a `done` or `blocked` branch around the step's own schema. The
// check is against draft-07, the SDK's dialect, with Ajv (TASK-004).
import { expect, test } from 'bun:test';
import Ajv from 'ajv';
import { submissionSchema, unwrap } from '../../../src/adapters/claude-code/envelope';

const STEP_SCHEMA = {
  type: 'object',
  properties: { summary: { type: 'string' } },
  required: ['summary'],
  additionalProperties: false,
};

test('the envelope accepts a done submission whose output fits the step schema and a blocked one with a reason, and rejects the rest', () => {
  const validate = new Ajv({ strict: true }).compile(submissionSchema(STEP_SCHEMA));
  const submissions = [
    { outcome: 'done', output: { summary: 'Add a --shout flag.' } },
    { outcome: 'blocked', reason: 'The brief has no acceptance criteria.' },
    { outcome: 'done', output: { summary: 3 } },
    { outcome: 'blocked', reason: '   ' },
    { outcome: 'done' },
    { outcome: 'retry', output: { summary: 'Add a --shout flag.' } },
  ];
  expect(submissions.map((submission) => validate(submission))).toEqual([true, true, false, false, false, false]);
});

test('a step schema whose $ref points at its own root, or at its own definitions, still validates its done output', () => {
  // review #1.4: wrapped under the envelope, "#" and "#/definitions/…" must still reach the step schema, not the envelope.
  const RECURSIVE = {
    type: 'object',
    properties: { summary: { type: 'string' }, children: { type: 'array', items: { $ref: '#' } } },
    required: ['summary'],
    additionalProperties: false,
  };
  const SHARED = {
    type: 'object',
    properties: { value: { $ref: '#/definitions/Value' } },
    required: ['value'],
    additionalProperties: false,
    definitions: { Value: { type: 'string' } },
  };
  const recursive = new Ajv({ strict: true }).compile(submissionSchema(RECURSIVE));
  const shared = new Ajv({ strict: true }).compile(submissionSchema(SHARED));
  expect({
    nested: recursive({ outcome: 'done', output: { summary: 'a', children: [{ summary: 'b', children: [] }] } }),
    badChild: recursive({ outcome: 'done', output: { summary: 'a', children: [{ summary: 3 }] } }),
    shared: shared({ outcome: 'done', output: { value: 'x' } }),
    badShared: shared({ outcome: 'done', output: { value: 3 } }),
  }).toEqual({ nested: true, badChild: false, shared: true, badShared: false });
});

test('a step schema with its own $id keeps its references, and literal data that looks like a $ref stays literal', () => {
  // review #2.2: a $id starts a new scope, so its references are left alone; and const, enum and default are data.
  const IDENTIFIED = {
    $id: 'https://example.invalid/tree',
    type: 'object',
    properties: { summary: { type: 'string' }, children: { type: 'array', items: { $ref: '#' } } },
    required: ['summary'],
    additionalProperties: false,
  };
  const LITERAL = {
    type: 'object',
    properties: { value: { const: { $ref: '#value' } } },
    required: ['value'],
    additionalProperties: false,
  };
  const identified = new Ajv({ strict: true }).compile(submissionSchema(IDENTIFIED));
  const literal = new Ajv({ strict: true }).compile(submissionSchema(LITERAL));
  expect({
    nested: identified({ outcome: 'done', output: { summary: 'a', children: [{ summary: 'b', children: [] }] } }),
    badChild: identified({ outcome: 'done', output: { summary: 'a', children: [{ summary: 3 }] } }),
    literal: literal({ outcome: 'done', output: { value: { $ref: '#value' } } }),
  }).toEqual({ nested: true, badChild: false, literal: true });
});

test('the envelope is a draft-07 oneOf with exactly two branches, one per outcome', () => {
  const schema = submissionSchema(STEP_SCHEMA) as { oneOf?: { properties?: { outcome?: { const?: string } } }[] };
  expect(schema.oneOf?.map((branch) => branch.properties?.outcome?.const)).toEqual(['done', 'blocked']);
});

test('unwrap gives the done output or the blocked reason of a valid envelope, and nothing for a malformed one', () => {
  expect([
    unwrap({ outcome: 'done', output: { summary: 'Add a --shout flag.' } }),
    unwrap({ outcome: 'blocked', reason: 'Needs a spec first.' }),
    unwrap({ outcome: 'done' }),
    unwrap({ outcome: 'blocked', reason: ' ' }),
    unwrap({ outcome: 'retry', output: {} }),
    unwrap('done'),
    unwrap(null),
  ]).toEqual([
    { outcome: 'done', output: { summary: 'Add a --shout flag.' } },
    { outcome: 'blocked', reason: 'Needs a spec first.' },
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
  ]);
});

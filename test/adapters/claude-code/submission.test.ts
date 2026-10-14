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

// biome-ignore format: TDD-PENDING TASK-002
test
  .skip // TDD-PENDING TASK-002
  ('the envelope is a plain object of outcome, output and reason, with only outcome required, and the step schema as output', () => {
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

// biome-ignore format: TDD-PENDING TASK-002
test
  .skip // TDD-PENDING TASK-002
  ("a step schema's $schema is dropped and its definitions hoisted, so its refs resolve: Ajv takes a done envelope and refuses bad output", () => {
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

// biome-ignore format: TDD-PENDING TASK-002
test
  .skip // TDD-PENDING TASK-002
  ('a $defs map is hoisted too, beside definitions', () => {
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

// biome-ignore format: TDD-PENDING TASK-002
test
  .skip // TDD-PENDING TASK-002
  .each<[string, unknown, unknown]>([
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

// biome-ignore format: TDD-PENDING TASK-002
test
  .skip // TDD-PENDING TASK-002
  ('the submit contract names both envelopes and says to submit exactly once', () => {
  expect({
    done: SUBMIT_CONTRACT.includes('"outcome": "done"'),
    blocked: SUBMIT_CONTRACT.includes('"outcome": "blocked"'),
    once: SUBMIT_CONTRACT.includes('exactly once'),
  }).toEqual({ done: true, blocked: true, once: true });
});

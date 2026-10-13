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

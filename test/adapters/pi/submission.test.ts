// The submit tool: it takes the done/blocked envelope, checks it against the step's schema, returns the errors to the
// model when it breaks it, and keeps the first valid submission, ending the session's turn.
import { expect, test } from 'bun:test';
import { submissionEnvelope } from '../../../src/adapters/claude-code/submission';
import { type Submitted, submitTool } from '../../../src/adapters/pi/submission';

const SCHEMA = {
  type: 'object',
  properties: { title: { type: 'string' }, points: { type: 'integer', minimum: 1 } },
  required: ['title', 'points'],
  additionalProperties: false,
};

function tool(schema: Record<string, unknown> = SCHEMA) {
  const kept: Submitted[] = [];
  return { tool: submitTool(schema, (submitted) => kept.push(submitted)), kept };
}

const text = (result: { content: { text: string }[] }) => result.content.map((block) => block.text).join('\n');

test('the tool is named submit and takes the envelope around the step schema', () => {
  const { tool: t } = tool();
  expect({ name: t.name, parameters: t.parameters }).toEqual({
    name: 'submit',
    parameters: submissionEnvelope(SCHEMA),
  });
});

test('a done submission whose output matches the schema is kept, and ends the turn', async () => {
  const { tool: t, kept } = tool();
  const result = await t.execute('c1', { outcome: 'done', output: { title: 'T', points: 3 } });
  expect({ kept, terminate: result.terminate, text: text(result) }).toEqual({
    kept: [{ outcome: 'done', output: { title: 'T', points: 3 } }],
    terminate: true,
    text: 'Submitted.',
  });
});

test('a blocked submission is kept with its reason', async () => {
  const { tool: t, kept } = tool();
  const result = await t.execute('c1', { outcome: 'blocked', reason: 'The ticket is missing.' });
  expect({ kept, terminate: result.terminate }).toEqual({
    kept: [{ outcome: 'blocked', reason: 'The ticket is missing.' }],
    terminate: true,
  });
});

test('an output that breaks the schema returns its errors to the model and keeps nothing', async () => {
  const { tool: t, kept } = tool();
  const result = await t.execute('c1', { outcome: 'done', output: { title: 'T', points: 0 } });
  expect({ kept, terminate: result.terminate }).toEqual({ kept: [], terminate: undefined });
  expect(text(result)).toBe(
    'The submission was not accepted. Fix these and submit again:\n- /output/points: must be >= 1',
  );
});

test('an envelope with no outcome, or a done one with no output, is returned too, and nothing is kept', async () => {
  const { tool: t, kept } = tool();
  const none = await t.execute('c1', { output: { title: 'T', points: 1 } });
  const bare = await t.execute('c2', { outcome: 'done' });
  expect(kept).toEqual([]);
  expect(text(none)).toContain('/outcome: is required');
  expect(text(bare)).toContain('/output: is required for a done submission');
});

test('a blocked submission with no reason is returned, and nothing is kept', async () => {
  const { tool: t, kept } = tool();
  const result = await t.execute('c1', { outcome: 'blocked' });
  expect(kept).toEqual([]);
  expect(text(result)).toContain('/reason: is required for a blocked submission');
});

test('only the first valid submission is kept; a later call is told so', async () => {
  const { tool: t, kept } = tool();
  await t.execute('c1', { outcome: 'blocked', reason: 'first' });
  const second = await t.execute('c2', { outcome: 'done', output: { title: 'T', points: 1 } });
  expect({ kept, text: text(second), terminate: second.terminate }).toEqual({
    kept: [{ outcome: 'blocked', reason: 'first' }],
    text: 'Already submitted.',
    terminate: true,
  });
});

test('a schema ajv cannot compile does not stop a submission: the envelope alone is checked', async () => {
  const { tool: t, kept } = tool({ type: 'object', properties: { a: { type: 'no-such-type' } } });
  await t.execute('c1', { outcome: 'done', output: { a: 1 } });
  expect(kept).toEqual([{ outcome: 'done', output: { a: 1 } }]);
});

import { expect, test } from 'bun:test';
import { intake, script, z } from '../../src/sdk/index';

const Output = z.object({ ref: z.string() });

test('intake() returns its options as given, under kind and name', () => {
  const fetch = script('fetch', { run: './fetch.sh', output: Output });
  expect(
    intake('design', { accepts: ['ticket', 'pr'], output: Output, produces: { 'brief.md': 'file' }, steps: [fetch] }),
  ).toEqual({
    kind: 'intake',
    name: 'design',
    accepts: ['ticket', 'pr'],
    output: Output,
    produces: { 'brief.md': 'file' },
    steps: [fetch],
  });
});

test('intake() defaults absent produces to an empty object, and has no steps until it is given some', () => {
  const declared = intake('bare', { accepts: ['pr'], output: Output });
  expect(declared).toEqual({ kind: 'intake', name: 'bare', accepts: ['pr'], output: Output, produces: {} });
  expect(declared).not.toHaveProperty('steps');
});

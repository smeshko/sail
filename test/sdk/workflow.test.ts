import { expect, test } from 'bun:test';
import { workflow } from '../../src/sdk/index';
import { ticket } from '../../src/sdk/intakes';

test('workflow() returns its options as given, with its body, under kind and name', async () => {
  const fn = async () => 'done';
  const defined = workflow(
    'ticket-to-pr',
    {
      intake: ticket,
      version: 1,
      description: 'A ticket to a pull request',
      watch: { every: '5m' },
      maxConcurrentRuns: 2,
    },
    fn,
  );
  expect(defined).toEqual({
    kind: 'workflow',
    name: 'ticket-to-pr',
    intake: ticket,
    version: 1,
    description: 'A ticket to a pull request',
    watch: { every: '5m' },
    maxConcurrentRuns: 2,
    fn,
  });
  expect(defined.fn).toBe(fn);
});

test('an unwatched workflow has neither watch nor maxConcurrentRuns', () => {
  const defined = workflow('manual', { intake: ticket }, async () => undefined);
  expect(defined).toEqual({ kind: 'workflow', name: 'manual', intake: ticket, fn: defined.fn });
  expect(defined).not.toHaveProperty('watch');
  expect(defined).not.toHaveProperty('maxConcurrentRuns');
});

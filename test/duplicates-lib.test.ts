import { expect, test } from 'bun:test';

const path = '../.sail/lib/duplicates.mjs';
const lib = await import(path);

test('same-work question uses the shared criteria', () => {
  expect(lib.sameWork('ticket', 'other')).toEqual({
    type: 'noul',
    instructions: 'Do `ticket` and `other` describe the same work?',
    criteria: {
      true: 'the same change: the same outcome in the same place, worded differently',
      false: 'a different change, even in the same area',
    },
  });
});

test('excerpt cuts descriptions after 600 characters', () => {
  expect(lib.excerpt(`${'a'.repeat(600)}b`)).toBe(`${'a'.repeat(600)}…`);
});

import { expect, test } from 'bun:test';
import { z } from 'zod';
import * as sail from '../../src/sdk';
import { isUntrusted, untrusted } from '../../src/sdk/untrusted';

test('isUntrusted is true for untrusted() and false for every other schema, and only untrusted is public', () => {
  const parsed: string = untrusted().parse('text');
  expect(parsed).toBe('text');
  expect(untrusted().safeParse(3).success).toBe(false);
  expect(isUntrusted(untrusted())).toBe(true);
  expect(isUntrusted(untrusted())).toBe(true);
  expect(untrusted()).not.toBe(untrusted());
  expect([z.string(), z.string().brand<'untrusted'>(), z.number(), untrusted().optional()].map(isUntrusted)).toEqual([
    false,
    false,
    false,
    false,
  ]);
  expect(typeof sail.untrusted).toBe('function');
  expect(sail).not.toHaveProperty('isUntrusted');
});

test('the mark survives the string methods, which still apply, and leaves no trace in JSON Schema', () => {
  const chained = [
    untrusted().max(400),
    untrusted().min(1),
    untrusted().trim(),
    untrusted().describe('a title'),
    untrusted().meta({ id: 'title' }),
  ];
  expect(chained.map(isUntrusted)).toEqual([true, true, true, true, true]);
  expect(untrusted().max(3).safeParse('four').success).toBe(false);
  expect(untrusted().max(3).safeParse('ok').success).toBe(true);
  const json = z.toJSONSchema(z.object({ title: untrusted().max(9) }), { target: 'draft-7' });
  expect(json.properties).toEqual({ title: { type: 'string', maxLength: 9 } });
  expect(z.toJSONSchema(z.object({ title: untrusted() }), { target: 'draft-7' }).properties).toEqual({
    title: { type: 'string' },
  });
});

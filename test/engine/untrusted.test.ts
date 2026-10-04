import { expect, test } from 'bun:test';
import { z } from 'zod';
import { isUntrustedInput, render } from '../../src/engine/render';
import { markUntrusted } from '../../src/engine/untrusted';
import { TicketInput } from '../../src/sdk/intakes';
import { untrusted } from '../../src/sdk/untrusted';

/** A value with each untrusted input shown as `<source>text`, so a case compares plain data. */
function shown(value: unknown): unknown {
  if (isUntrustedInput(value)) return `<${value.source}>${value.text}`;
  if (Array.isArray(value)) return value.map(shown);
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, shown(item)]));
  }
  return value;
}

const input = {
  ticketKey: 'FAKE-9',
  title: 'A title',
  url: 'fake://tickets/FAKE-9',
  acceptanceCriteria: ['one', 'two'],
};

test('markUntrusted marks a ticket title and each criterion with its path, and nothing else', () => {
  const copy = structuredClone(input);
  const marked = markUntrusted(TicketInput, input, 'ticket');
  expect(shown(marked)).toEqual({
    ticketKey: 'FAKE-9',
    title: '<ticket.title>A title',
    url: 'fake://tickets/FAKE-9',
    acceptanceCriteria: ['<ticket.acceptanceCriteria.0>one', '<ticket.acceptanceCriteria.1>two'],
  });
  expect(input).toEqual(copy);
});

test('a template prints the marked title wrapped and the ticket key bare', () => {
  const rendered = render('{{ticket.title}} {{ticket.ticketKey}}', {
    ticket: markUntrusted(TicketInput, input, 'ticket'),
  });
  expect(rendered.text).toBe('<untrusted-input source="ticket.title">A title</untrusted-input> FAKE-9');
  expect(rendered.untrusted).toBe(1);
});

test('an untrusted string schema marks a string value with the source as given', () => {
  expect(shown(markUntrusted(untrusted(), 'text', 'binding'))).toBe('<binding>text');
});

test('a marked string is found under each wrapper and container a schema can hold', () => {
  const Tree: z.ZodType = z.object({ name: untrusted(), kids: z.lazy(() => z.array(Tree)) });
  const cases: Record<string, [z.ZodType, unknown, unknown]> = {
    optional: [z.object({ a: untrusted().optional() }), { a: 'x' }, { a: '<s.a>x' }],
    nullable: [z.object({ a: untrusted().nullable() }), { a: 'x' }, { a: '<s.a>x' }],
    default: [z.object({ a: untrusted().default('d' as never) }), { a: 'x' }, { a: '<s.a>x' }],
    readonly: [z.object({ a: untrusted().readonly() }), { a: 'x' }, { a: '<s.a>x' }],
    array: [z.array(untrusted()), ['x', 'y'], ['<s.0>x', '<s.1>y']],
    tuple: [z.tuple([z.string(), untrusted()]), ['k', 'x'], ['k', '<s.1>x']],
    'tuple rest': [z.tuple([z.string()], untrusted()), ['k', 'x', 'y'], ['k', '<s.1>x', '<s.2>y']],
    record: [z.record(z.string(), untrusted()), { a: 'x', b: 'y' }, { a: '<s.a>x', b: '<s.b>y' }],
    'nested object': [z.object({ a: z.object({ b: untrusted() }) }), { a: { b: 'x' } }, { a: { b: '<s.a.b>x' } }],
    catchall: [
      z.object({ id: z.string() }).catchall(untrusted()),
      { id: '1', extra: 'x' },
      { id: '1', extra: '<s.extra>x' },
    ],
    intersection: [
      z.object({ a: untrusted() }).and(z.object({ b: z.string(), c: untrusted() })),
      { a: 'x', b: 'y', c: 'z' },
      { a: '<s.a>x', b: 'y', c: '<s.c>z' },
    ],
    lazy: [
      Tree,
      { name: 'root', kids: [{ name: 'leaf', kids: [] }] },
      { name: '<s.name>root', kids: [{ name: '<s.kids.0.name>leaf', kids: [] }] },
    ],
    'pipe in': [untrusted().pipe(z.string().min(1) as never), 'x', '<s>x'],
    'pipe out': [z.string().pipe(untrusted() as never), 'x', '<s>x'],
    // a string with no mark stays plain, and so does anything the schema can't see
    unmarked: [
      z.object({
        s: z.string(),
        e: z.enum(['a', 'b']),
        l: z.literal('c'),
        any: z.any(),
        unknown: z.unknown(),
        m: untrusted(),
      }),
      { s: 'x', e: 'a', l: 'c', any: 'y', unknown: 'z', m: 'w' },
      { s: 'x', e: 'a', l: 'c', any: 'y', unknown: 'z', m: '<s.m>w' },
    ],
    // null, undefined and a value that does not fit its schema come back as they are
    'null value': [z.object({ a: untrusted() }), null, null],
    'undefined value': [z.object({ a: untrusted() }), undefined, undefined],
    'null field': [z.object({ a: untrusted() }), { a: null }, { a: null }],
    'number for object': [z.object({ a: untrusted() }), 3, 3],
    'text for array': [z.array(untrusted()), 'text', 'text'],
    'object for tuple': [z.tuple([untrusted()]), { a: 1 }, { a: 1 }],
    'list for record': [z.record(z.string(), untrusted()), ['x'], ['x']],
    'number for untrusted': [untrusted(), 5, 5],
  };
  const actual = Object.fromEntries(
    Object.entries(cases).map(([name, [schema, value]]) => [name, shown(markUntrusted(schema, value, 's'))]),
  );
  const expected = Object.fromEntries(Object.entries(cases).map(([name, [, , marked]]) => [name, marked]));
  expect(actual).toEqual(expected);
});

test('in a union and a discriminated union a string is marked when any option marks it', () => {
  const union = z.union([z.object({ note: z.string() }), z.object({ note: untrusted() })]);
  expect(shown(markUntrusted(union, { note: 'x' }, 's'))).toEqual({ note: '<s.note>x' });
  const discriminated = z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('a'), note: z.string() }),
    z.object({ kind: z.literal('b'), note: untrusted() }),
  ]);
  expect(shown(markUntrusted(discriminated, { kind: 'a', note: 'x' }, 's'))).toEqual({ kind: 'a', note: '<s.note>x' });
});

test('a key the schema does not declare is kept as it is', () => {
  const schema = z.object({ a: untrusted() });
  expect(shown(markUntrusted(schema, { a: 'x', other: 'y', n: 1 }, 's'))).toEqual({ a: '<s.a>x', other: 'y', n: 1 });
});

test('marking twice changes nothing', () => {
  const once = markUntrusted(TicketInput, input, 'ticket');
  const twice = markUntrusted(TicketInput, once, 'other');
  expect(shown(once)).toMatchObject({ title: '<ticket.title>A title' });
  expect(shown(twice)).toEqual(shown(once));
});

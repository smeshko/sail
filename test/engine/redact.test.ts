// The redactor: a secret masked in each form it can take, in text, in nested values and in errors (DECISIONS D11).
import { expect, test } from 'bun:test';
import { REDACTED, redactor } from '../../src/engine/redact';
import { PortError } from '../../src/ports/errors';

const SECRET = 'ghp_MARKER_7c1d/9e+a=f';
const base64 = (text: string) => Buffer.from(text).toString('base64');

test('a secret is masked as written, URL-encoded, in base64 and inside the x-access-token Basic credential', () => {
  const { text } = redactor([SECRET]);
  const forms = [
    `token ${SECRET} sent`,
    `https://x:${encodeURIComponent(SECRET)}@github.com/o/r`,
    `seen ${base64(SECRET)}`,
    `Authorization: Basic ${base64(`x-access-token:${SECRET}`)}`,
  ];
  expect(forms.map(text)).toEqual([
    `token ${REDACTED} sent`,
    `https://x:${REDACTED}@github.com/o/r`,
    `seen ${REDACTED}`,
    `Authorization: Basic ${REDACTED}`,
  ]);
});

test('a value is masked at every depth, keys included, and what is no string passes through', () => {
  const { value } = redactor([SECRET]);
  const input = {
    message: `bad ${SECRET}`,
    errors: [{ message: SECRET, code: 422 }, [`deep ${SECRET}`]],
    [SECRET]: true,
    none: null,
    missing: undefined,
    count: 3,
  };
  expect<unknown>(value(input)).toEqual({
    message: `bad ${REDACTED}`,
    errors: [{ message: REDACTED, code: 422 }, [`deep ${REDACTED}`]],
    [REDACTED]: true,
    none: null,
    missing: undefined,
    count: 3,
  });
  expect(input.message).toBe(`bad ${SECRET}`);
});

test('a secret that contains another leaves no fragment of the longer one, and a redactor of no secrets changes nothing', () => {
  expect(redactor(['abc', 'abcdef']).text('x abcdef y abc z')).toBe(`x ${REDACTED} y ${REDACTED} z`);
  expect(redactor([]).text(`keep ${SECRET}`)).toBe(`keep ${SECRET}`);
  expect(redactor(['']).value({ a: 'kept' })).toEqual({ a: 'kept' });
});

test("a PortError keeps its port, op and code with its message and raw masked, and any other error's message is masked", () => {
  const { error } = redactor([SECRET]);
  const masked = error(new PortError('codeHost', 'push', 'unauthorized', `denied ${SECRET}`, { echo: SECRET }));
  const plain = error(new Error(`boom ${SECRET}`));
  expect([
    masked instanceof PortError ? [masked.port, masked.op, masked.code, masked.raw] : 'not a PortError',
    masked.message,
    plain.message,
  ]).toEqual([
    ['codeHost', 'push', 'unauthorized', { echo: REDACTED }],
    `codeHost.push: denied ${REDACTED}`,
    `boom ${REDACTED}`,
  ]);
});

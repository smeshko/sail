// The redactor: a secret masked in each form it can take, in text, in nested values and in errors (DECISIONS D11).
import { expect, test } from 'bun:test';
import { existsSync, lstatSync, mkdtempSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { REDACTED, redactFile, redactor } from '../../src/engine/redact';
import { PortError } from '../../src/ports/errors';

const SECRET = 'ghp_MARKER_7c1d/9e+a=f';
test('a secret is masked JSON-escaped, as a line of port-events.ndjson holds it', () => {
  const secret = 'pa"ss\\word\tx';
  expect(redactor([secret]).text(JSON.stringify({ message: `bad ${secret}` }))).toBe('{"message":"bad [redacted]"}');
});

test('base64 behind a one-byte lead is masked', () => {
  expect(redactor([SECRET]).text(base64(`user:${SECRET}`))).toBe('dXNlcjpn[redacted]');
});

test('base64 behind an aligned prefix remains masked', () => {
  expect(redactor([SECRET]).text(base64(`ab:${SECRET}`))).toBe('YWI6[redacted]');
});

test('base64 behind a two-byte prefix is masked', () => {
  expect(redactor([SECRET]).text(base64(`ab${SECRET}`))).toBe('YWJn[redacted]');
});

test('base64 behind a one-byte prefix is masked', () => {
  expect(redactor([SECRET]).text(base64(`x${SECRET}`))).toBe('eGdo[redacted]PWY=');
});

test('whole files mask a credential across a chunk boundary and preserve split UTF-8', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'sail-redact-')), 'log');
  const prefix = 'a'.repeat(65530);
  writeFileSync(path, `${prefix}${SECRET}終${'b'.repeat(65490)}終${SECRET}`);
  redactFile(path, redactor([SECRET]));
  expect(readFileSync(path, 'utf8')).toBe(`${prefix}[redacted]終${'b'.repeat(65490)}終[redacted]`);
});

test('whole files preserve clean bytes and missing files', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'sail-redact-')), 'log');
  redactFile(path, redactor([SECRET]));
  expect(existsSync(path)).toBe(false);
  const clean = `${'a'.repeat(65535)}終\n`;
  writeFileSync(path, clean);
  redactFile(path, redactor([SECRET]));
  expect(readFileSync(path, 'utf8')).toBe(clean);
  writeFileSync(path, SECRET);
  redactFile(path, redactor([]));
  expect(readFileSync(path, 'utf8')).toBe(SECRET);
});

test('whole files keep invalid UTF-8 and a character on the cut, and a clean file keeps its mode', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sail-redact-'));
  const binary = join(dir, 'binary');
  writeFileSync(binary, Buffer.concat([Buffer.from([0x41, 0xff, 0xfe, 0x42]), Buffer.from(` ${SECRET}\n`)]));
  redactFile(binary, redactor([SECRET]));
  expect(readFileSync(binary)).toEqual(
    Buffer.concat([Buffer.from([0x41, 0xff, 0xfe, 0x42]), Buffer.from(' [redacted]\n')]),
  );
  const emoji = join(dir, 'emoji');
  writeFileSync(emoji, `${'🚀'.repeat(100000)} ${SECRET}`);
  redactFile(emoji, redactor([SECRET]));
  expect(readFileSync(emoji, 'utf8')).toBe(`${'🚀'.repeat(100000)} [redacted]`);
  const status = join(dir, 'status');
  const line = `{"status":"🎉${'a'.repeat(51)}"}\n`;
  writeFileSync(status, line, { mode: 0o644 });
  redactFile(status, redactor(['x'.repeat(25)]));
  expect([readFileSync(status, 'utf8'), statSync(status).mode & 0o777]).toEqual([line, 0o644]);
});

test('whole files replace a link without overwriting its target', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sail-redact-'));
  const target = join(dir, 'target');
  const path = join(dir, 'log');
  writeFileSync(target, SECRET);
  symlinkSync(target, path);
  redactFile(path, redactor([SECRET]));
  expect(readFileSync(path, 'utf8')).toBe('[redacted]');
  expect(lstatSync(path).isSymbolicLink()).toBe(false);
  expect(readFileSync(target, 'utf8')).toBe(SECRET);
});

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

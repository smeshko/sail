import { expect, test } from 'bun:test';
import { newRunId, ulid } from '../../src/engine/run-id';

const CROCKFORD = /^[0-9A-HJKMNP-TV-Z]{26}$/;

test('a ULID is 26 characters of Crockford base32', () => {
  expect(ulid()).toMatch(CROCKFORD);
});

test('a fixed time and fixed random bytes give a known ULID', () => {
  // The ULID spec's example time: its first ten characters are 01ARYZ6S41.
  expect(ulid(1469918176385, (bytes) => bytes.fill(0))).toBe('01ARYZ6S410000000000000000');
  expect(ulid(1469918176385, (bytes) => bytes.fill(0xff))).toBe('01ARYZ6S41ZZZZZZZZZZZZZZZZ');
  expect(ulid(0, (bytes) => bytes.fill(0))).toBe('0'.repeat(26));
});

test('two ULIDs from the same millisecond differ, and a later time sorts after an earlier one', () => {
  const now = Date.now();
  expect(ulid(now)).not.toBe(ulid(now));
  expect(ulid(now + 1) > ulid(now)).toBe(true);
  expect(ulid(1000, (bytes) => bytes.fill(0xff)) < ulid(1001, (bytes) => bytes.fill(0))).toBe(true);
});

test.each([[-1], [1.5], [2 ** 48]])('a time of %p is refused', (now) => {
  expect(() => ulid(now)).toThrow('time');
});

test('a run id is the key, a dash, then a ULID', () => {
  expect(newRunId('FAKE-1')).toMatch(/^FAKE-1-[0-9A-HJKMNP-TV-Z]{26}$/);
  expect(newRunId('tests', 1469918176385)).toStartWith('tests-01ARYZ6S41');
});

test.each([[''], ['a/b'], ['a b'], ['ä']])('a key of %p is refused', (key) => {
  expect(() => newRunId(key)).toThrow('run id key');
});

import { expect, test } from 'bun:test';
import { newRunId, ulid } from '../../src/engine/run-id';
import { GOLDEN_START, goldenRandom } from '../helpers/clock';

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

test('a run id on a fixed time and fixed random bytes is known, and without the bytes its 16 random characters differ', () => {
  const now = Date.parse(GOLDEN_START);
  expect(newRunId('FAKE-1', now, goldenRandom)).toBe('FAKE-1-01M3BWNZM08Q4T6V2XRJ5KWD3N');
  const [one, two] = [newRunId('FAKE-1', now), newRunId('FAKE-1', now)];
  expect([one.slice(0, 17), two.slice(0, 17)]).toEqual(['FAKE-1-01M3BWNZM0', 'FAKE-1-01M3BWNZM0']);
  expect([one.slice(17).length, two.slice(17).length]).toEqual([16, 16]);
  expect(one.slice(17)).not.toBe(two.slice(17));
});

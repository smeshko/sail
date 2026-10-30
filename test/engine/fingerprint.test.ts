import { expect, test } from 'bun:test';
import { bindingChanges, canonicalJson, fingerprintBindings } from '../../src/engine/fingerprint';

const value = (v: unknown) => ({ kind: 'value' as const, value: v, from: 'workflow' });
const file = (path: string) => ({ kind: 'file' as const, path: `/run/${path}`, from: path });

test('canonicalJson gives one text for objects whose keys differ only in order, at any depth', () => {
  expect(canonicalJson({ b: 1, a: { d: [{ y: 1, x: 2 }], c: 3 } })).toBe('{"a":{"c":3,"d":[{"x":2,"y":1}]},"b":1}');
  expect(canonicalJson({ a: 1, b: 2 })).toBe(canonicalJson({ b: 2, a: 1 }));
});

test('canonicalJson honours toJSON', () => {
  expect(canonicalJson({ at: new Date(Date.UTC(2026, 0, 2)) })).toBe('{"at":"2026-01-02T00:00:00.000Z"}');
  expect(canonicalJson({ toJSON: () => ({ z: 1, a: 2 }) })).toBe('{"a":2,"z":1}');
});

test('canonicalJson throws on a cycle and on a BigInt', () => {
  const cycle: Record<string, unknown> = {};
  cycle.self = cycle;
  expect(() => canonicalJson(cycle)).toThrow();
  expect(() => canonicalJson({ n: 1n })).toThrow();
});

test('fingerprintBindings gives one 16-hex hash per value and file binding', () => {
  const hashes = fingerprintBindings({ data: value('one'), doc: file('01-a/call-1/out.md') });
  expect(Object.keys(hashes)).toEqual(['data', 'doc']);
  expect(hashes.data).toMatch(/^[0-9a-f]{16}$/);
  expect(hashes.doc).toMatch(/^[0-9a-f]{16}$/);
});

test('fingerprintBindings is equal for equal values and different for different ones', () => {
  expect(fingerprintBindings({ x: value({ a: 1, b: 2 }) })).toEqual(fingerprintBindings({ x: value({ b: 2, a: 1 }) }));
  expect(fingerprintBindings({ x: value('one') }).x).not.toBe(fingerprintBindings({ x: value('two') }).x);
  expect(fingerprintBindings({ x: file('a/out.md') }).x).not.toBe(fingerprintBindings({ x: file('b/out.md') }).x);
});

test('fingerprintBindings tells a value string from a file with that path', () => {
  const path = '01-a/call-1/out.md';
  expect(fingerprintBindings({ x: value(path) }).x).not.toBe(fingerprintBindings({ x: file(path) }).x);
});

test('fingerprintBindings skips gitDiff and fromStep bindings', () => {
  const hashes = fingerprintBindings({
    patch: { kind: 'gitDiff', patch: 'diff', from: 'workspace' },
    prior: { kind: 'fromStep', value: 1, from: 'x' },
    priorFile: { kind: 'fromStep', path: '/run/x', from: 'x' },
    data: value(1),
  });
  expect(Object.keys(hashes)).toEqual(['data']);
});

test('bindingChanges names changed, appeared and went bindings in that order, sorted by name', () => {
  const journaled = {
    b: '0000000000000001',
    a: '0000000000000002',
    gone2: '0000000000000003',
    gone1: '0000000000000004',
  };
  const asked = { b: '0000000000000009', a: '0000000000000002', new2: '0000000000000005', new1: '0000000000000006' };
  expect(bindingChanges(journaled, asked)).toBe(
    "'b' changed, 'new1' appeared, 'new2' appeared, 'gone1' went, 'gone2' went",
  );
});

test('bindingChanges returns undefined for equal maps', () => {
  expect(bindingChanges({ a: '0000000000000001' }, { a: '0000000000000001' })).toBeUndefined();
  expect(bindingChanges({}, {})).toBeUndefined();
});

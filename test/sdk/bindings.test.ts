import { describe, expect, test } from 'bun:test';
import { z as zod } from 'zod';
import { file, fromStep, gitDiff, value, z } from '../../src/sdk/index';

const Feedback = zod.object({ ok: zod.boolean() });

describe('binding constructors return plain descriptors', () => {
  test('file() names the produced file', () => {
    expect(file('spec.md')).toMatchObject({ kind: 'file', name: 'spec.md', isOptional: false });
  });

  test('value() carries its schema', () => {
    const binding = value(Feedback);
    expect(binding).toMatchObject({ kind: 'value', isOptional: false });
    expect(binding.schema).toBe(Feedback);
  });

  test('gitDiff() carries its range', () => {
    expect(gitDiff('origin/main...HEAD')).toMatchObject({
      kind: 'gitDiff',
      range: 'origin/main...HEAD',
      isOptional: false,
    });
  });

  test('a descriptor holds no brand at run time', () => {
    expect(Object.getOwnPropertySymbols(file('spec.md'))).toEqual([]);
    expect(JSON.parse(JSON.stringify(file('spec.md')))).toEqual({ kind: 'file', name: 'spec.md', isOptional: false });
  });
});

describe('fromStep() is a builder for a previous step', () => {
  test('it is not a binding itself', () => {
    expect(fromStep('describe')).not.toHaveProperty('kind');
  });

  test('.output() binds the whole output', () => {
    expect(fromStep('describe').output()).toMatchObject({ kind: 'fromStep', step: 'describe', isOptional: false });
    expect(fromStep('describe').output()).not.toHaveProperty('key');
  });

  test('.output(key) binds one field of it', () => {
    expect(fromStep('describe').output('title')).toMatchObject({
      kind: 'fromStep',
      step: 'describe',
      key: 'title',
      isOptional: false,
    });
  });

  test('.file(name) binds a file the step produced', () => {
    expect(fromStep('describe').file('pr-body.md')).toMatchObject({
      kind: 'fromStep',
      step: 'describe',
      file: 'pr-body.md',
      isOptional: false,
    });
  });
});

describe('.optional()', () => {
  const kinds = {
    file: () => file('spec.md'),
    value: () => value(Feedback),
    gitDiff: () => gitDiff('HEAD~1...HEAD'),
    'fromStep output': () => fromStep('describe').output('title'),
    'fromStep file': () => fromStep('describe').file('pr-body.md'),
  };

  test.each(Object.entries(kinds))(
    'returns an optional copy of a %s binding and leaves the original alone',
    (_, make) => {
      const required = make();
      const optional = required.optional();
      expect(optional).not.toBe(required);
      expect(optional.isOptional).toBe(true);
      expect(required.isOptional).toBe(false);
      expect({ ...optional, isOptional: false }).toEqual({ ...required });
    },
  );

  test('is idempotent', () => {
    expect(file('spec.md').optional().optional()).toMatchObject({ kind: 'file', name: 'spec.md', isOptional: true });
  });
});

test('z from sail is the z from zod: one instance', () => {
  expect(z).toBe(zod);
  expect(z.object).toBe(zod.object);
});

// The registry of the built-in intakes' bodies: one per intake `sail/intakes` exports.
import { expect, test } from 'bun:test';
import { BUILTIN_INTAKES } from '../../../src/builtins/intakes/index';
import { ticketIntake } from '../../../src/builtins/intakes/ticket/index';
import type { Intake } from '../../../src/sdk/intake';
import * as intakes from '../../../src/sdk/intakes';

const isIntake = (value: unknown): value is Intake =>
  typeof value === 'object' && value !== null && (value as { kind?: unknown }).kind === 'intake';

// biome-ignore format: TDD-PENDING TASK-003
test
  .skip // TDD-PENDING TASK-003
  ('BUILTIN_INTAKES holds a body for every intake sail/intakes exports, and for nothing else', () => {
  const exported = Object.values<unknown>(intakes).filter(isIntake);
  expect(exported.map((intake) => intake.name)).toEqual(['ticket']);
  expect([...BUILTIN_INTAKES.keys()]).toEqual(exported);
  expect(BUILTIN_INTAKES.get(intakes.ticket)).toBe(ticketIntake);
});

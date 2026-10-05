// The event union and `sail.event.v1` name the same types, in the same order.
import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { EVENT_TYPES, type ProviderEvent } from '../../src/events/types';

// An adapter emits a provider event without a key, and its caller stamps one: a workspace event never has one. Checked
// by `bun run typecheck`, which fails if the directive goes unused.
const _workspaceEvents: ProviderEvent[] = [
  { type: 'workspace:leased', remote: 'fake://codehost/fixture', branch: 'sail/FAKE-1' },
  // @ts-expect-error TS2353: workspace events carry no key
  { type: 'workspace:leased', remote: 'fake://codehost/fixture', branch: 'sail/FAKE-1', key: 'spec#1' },
];

/** The `type` enum wherever the schema keeps it: the first `properties.type.enum` in a depth-first walk. */
function typeEnum(schema: unknown): unknown {
  if (typeof schema !== 'object' || schema === null) return undefined;
  const found = (schema as { properties?: { type?: { enum?: unknown } } }).properties?.type?.enum;
  if (Array.isArray(found)) return found;
  for (const value of Object.values(schema)) {
    const nested = typeEnum(value);
    if (nested !== undefined) return nested;
  }
  return undefined;
}

// biome-ignore format: TDD-PENDING TASK-001
test
  .skip // TDD-PENDING TASK-001
  ("EVENT_TYPES is sail.event.v1's type enum, error:consumer and prompt:rendered included", async () => {
  const schema = await Bun.file(join(import.meta.dir, '..', '..', 'schemas', 'sail.event.v1.json')).json();
  expect(typeEnum(schema)).toEqual([...EVENT_TYPES]);
  expect(EVENT_TYPES).toHaveLength(52);
  expect(EVENT_TYPES.indexOf('error:consumer')).toBe(EVENT_TYPES.indexOf('error:crash') + 1);
  expect(EVENT_TYPES.indexOf('prompt:rendered')).toBe(EVENT_TYPES.indexOf('input:materialised') + 1);
});

// The event union and `sail.event.v1` name the same types, in the same order.
import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { EVENT_TYPES } from '../../src/events/types';

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
  ("EVENT_TYPES is sail.event.v1's type enum, error:consumer included", async () => {
    const schema = await Bun.file(join(import.meta.dir, '..', '..', 'schemas', 'sail.event.v1.json')).json();
    expect(typeEnum(schema)).toEqual([...EVENT_TYPES]);
    expect(EVENT_TYPES).toHaveLength(51);
    expect(EVENT_TYPES.indexOf('error:consumer')).toBe(EVENT_TYPES.indexOf('error:crash') + 1);
  });

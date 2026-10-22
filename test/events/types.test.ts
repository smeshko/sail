// The event unions and `sail.event.v1` name the same types, in the same order: a run's, then a queue's.
import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { EVENT_TYPES, type ProviderEvent, QUEUE_EVENT_TYPES } from '../../src/events/types';

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

test("EVENT_TYPES holds a run's 50 types, error:consumer and prompt:rendered included", () => {
  expect(EVENT_TYPES).toHaveLength(50);
  expect(EVENT_TYPES.indexOf('error:consumer')).toBe(EVENT_TYPES.indexOf('error:crash') + 1);
  expect(EVENT_TYPES.indexOf('prompt:rendered')).toBe(EVENT_TYPES.indexOf('input:materialised') + 1);
});

test("sail.event.v1's type enum is EVENT_TYPES, then the 12 QUEUE_EVENT_TYPES from error:consumer on, queue:dropped after queue:skipped_leased, and run:adopted, run:resumed and queue:requeued last", async () => {
  const schema = await Bun.file(join(import.meta.dir, '..', '..', 'schemas', 'sail.event.v1.json')).json();
  const types = typeEnum(schema) as string[];
  expect(types).toEqual([...EVENT_TYPES, ...QUEUE_EVENT_TYPES]);
  expect(QUEUE_EVENT_TYPES).toHaveLength(12);
  expect(types.slice(-3)).toEqual(['run:adopted', 'run:resumed', 'queue:requeued']);
  expect(types.indexOf('watch:added')).toBe(types.indexOf('error:consumer') + 1);
  expect(types.indexOf('queue:dropped')).toBe(types.indexOf('queue:skipped_leased') + 1);
});

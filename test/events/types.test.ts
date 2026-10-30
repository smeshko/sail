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

test("EVENT_TYPES holds a run's 64 types, error:consumer, error:port, prompt:rendered, run:suspended, run:keep_awake, budget:raised, step:queued, ticket:created, ticket:attached, ticket:labelled, ticket:unlabelled, ticket:related, ticket:edited, jev:asked and codehost:checks_rerun included", () => {
  expect(EVENT_TYPES).toHaveLength(64);
  expect(EVENT_TYPES.indexOf('step:stalled')).toBe(EVENT_TYPES.indexOf('step:queued') + 1);
  const types: readonly string[] = EVENT_TYPES;
  expect(types.indexOf('run:suspended')).toBe(types.indexOf('run:end') + 1);
  expect(types.indexOf('run:keep_awake')).toBe(types.indexOf('run:suspended') + 1);
  expect(types.indexOf('budget:raised')).toBe(types.indexOf('budget:exceeded') + 1);
  expect(types.indexOf('ticket:created')).toBe(types.indexOf('ticket:commented') + 1);
  expect(types.indexOf('ticket:attached')).toBe(types.indexOf('ticket:created') + 1);
  expect(types.indexOf('ticket:labelled')).toBe(types.indexOf('ticket:attached') + 1);
  expect(types.indexOf('ticket:unlabelled')).toBe(types.indexOf('ticket:labelled') + 1);
  expect(types.indexOf('ticket:related')).toBe(types.indexOf('ticket:unlabelled') + 1);
  expect(types.indexOf('ticket:edited')).toBe(types.indexOf('ticket:related') + 1);
  expect(EVENT_TYPES.indexOf('error:consumer')).toBe(EVENT_TYPES.indexOf('error:crash') + 1);
  expect(EVENT_TYPES.indexOf('error:port')).toBe(EVENT_TYPES.indexOf('error:consumer') + 1);
  expect(EVENT_TYPES.indexOf('prompt:rendered')).toBe(EVENT_TYPES.indexOf('input:materialised') + 1);
});

test("sail.event.v1's type enum is EVENT_TYPES, then the 15 QUEUE_EVENT_TYPES from error:port on, queue:dropped after queue:skipped_leased, and run:adopted, run:resumed, queue:requeued, queue:held, queue:released and queue:moved last", async () => {
  const schema = await Bun.file(join(import.meta.dir, '..', '..', 'schemas', 'sail.event.v1.json')).json();
  const types = typeEnum(schema) as string[];
  expect(types).toEqual([...EVENT_TYPES, ...QUEUE_EVENT_TYPES]);
  expect(QUEUE_EVENT_TYPES).toHaveLength(15);
  expect(types.slice(-6)).toEqual([
    'run:adopted',
    'run:resumed',
    'queue:requeued',
    'queue:held',
    'queue:released',
    'queue:moved',
  ]);
  expect(types.indexOf('watch:added')).toBe(types.indexOf('error:port') + 1);
  expect(types.indexOf('queue:dropped')).toBe(types.indexOf('queue:skipped_leased') + 1);
});

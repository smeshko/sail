// The core's knowledge of each port without calling it: the operations an adapter must have and the schema its
// capabilities parse with (DECISIONS D9). The fakes, built with 5.1's factories, are the adapters that show the tables
// are right.
import { expect, test } from 'bun:test';
import { join } from 'node:path';
import {
  createFakeCodeHost,
  createFakeHarness,
  createFakeTicketSource,
  createFakeWorkspace,
} from '../../src/adapters/index';
import { PORTS, type Port } from '../../src/engine/config';
import { PORT_CAPABILITIES, PORT_OPERATIONS } from '../../src/ports/adapter';
import { OPERATIONS } from '../helpers/adapters';

const FIXTURE = join(import.meta.dir, '..', 'fixtures', 'repo');
const SEED = join(FIXTURE, '.sail', 'fake');

/** One fake per port, built with 5.1's factory over the fixture's seeds. Nothing is read until an operation runs. */
const FAKES: Record<Port, object> = {
  ticketSource: createFakeTicketSource({ seed: join(SEED, 'tickets.json'), state: join(SEED, 'state-tickets.json') }),
  codeHost: createFakeCodeHost({ seed: join(SEED, 'prs.json'), state: join(SEED, 'state-prs.json') }),
  harness: createFakeHarness({ script: join(SEED, 'harness.json') }),
  workspace: createFakeWorkspace({ repo: FIXTURE }),
};

test.each([...PORTS])(
  "%s: the operations table is the fake adapter's methods, with capabilities in and name out",
  (port) => {
    const table: string[] = [...PORT_OPERATIONS[port]].sort();
    expect(table).toEqual(OPERATIONS[port]);
    expect(new Set(table).size).toBe(table.length);
    const fake = FAKES[port] as Record<string, unknown>;
    expect(table.filter((name) => typeof fake[name] !== 'function')).toEqual([]);
    expect(table).not.toContain('name');
  },
);

test.each([...PORTS])("%s: the capabilities schema parses the fake's capabilities()", (port) => {
  const fake = FAKES[port] as { capabilities(): unknown };
  const parsed = PORT_CAPABILITIES[port].safeParse(fake.capabilities());
  expect(parsed.success).toBe(true);
  expect(PORT_CAPABILITIES[port].safeParse({}).success).toBe(false);
});

// The port events file: what a `sail port` under a script step appends, and what the engine takes from it when the
// step ends. Only a whole line that is a `ticket:*` or `codehost:*` event, with no envelope, is a provider event.
import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendPortEvent, PORT_EVENTS_FILE, readPortEvents } from '../../src/engine/port-events';
import type { ProviderEvent } from '../../src/events/types';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** The path of a port events file in a fresh directory. Nothing is written there yet. */
function eventsFile(): string {
  const dir = mkdtempSync(join(tmpdir(), 'sail-port-events-'));
  dirs.push(dir);
  return join(dir, PORT_EVENTS_FILE);
}

const ENVELOPE = { runId: 'FAKE-1-01M3BWNZM08Q4T6V2XRJ5KWD3N', key: 'open#1' };
const PUSHED: ProviderEvent = { type: 'codehost:pushed', branch: 'sail/FAKE-1', headSha: 'a'.repeat(40) };
const LABELLED: ProviderEvent = { type: 'codehost:labelled', number: 5, label: 'sail', change: 'added' };
const COMMENTED: ProviderEvent = { type: 'ticket:commented', ticketKey: 'FAKE-1', body: 'Opened a pull request.' };
const line = (value: unknown) => `${JSON.stringify(value)}\n`;
const problem = (at: number, why: string) => `port-events.ndjson line ${at} is not a provider event: ${why}`;

test('the file is port-events.ndjson, and each event appended is one line of JSON with no envelope, in the order appended', () => {
  const path = eventsFile();
  expect(PORT_EVENTS_FILE).toBe('port-events.ndjson');
  appendPortEvent(path, PUSHED);
  appendPortEvent(path, LABELLED);
  expect(existsSync(path) ? readFileSync(path, 'utf8') : null).toBe(
    `{"type":"codehost:pushed","branch":"sail/FAKE-1","headSha":"${'a'.repeat(40)}"}\n` +
      '{"type":"codehost:labelled","number":5,"label":"sail","change":"added"}\n',
  );
});

test('reading gives back the events appended, ticket and codehost events alike, and a file that is not there holds none', () => {
  const path = eventsFile();
  expect(readPortEvents(path, ENVELOPE)).toEqual({ events: [], problems: [] });
  for (const event of [PUSHED, COMMENTED, LABELLED]) appendPortEvent(path, event);
  expect(readPortEvents(path, ENVELOPE)).toEqual({ events: [PUSHED, COMMENTED, LABELLED], problems: [] });
});

test.each([
  ['text that is not JSON', 'pushed sail/FAKE-1\n', 'it is not JSON'],
  ['a blank line', '\n', 'it is not JSON'],
  ['a JSON array', line([PUSHED]), 'it is not a JSON object'],
  ['a JSON string', line('codehost:pushed'), 'it is not a JSON object'],
  ['null', line(null), 'it is not a JSON object'],
  ['a line that carries seq', line({ ...PUSHED, seq: 7 }), 'it carries seq, which the run stamps'],
  [
    'a line that carries ts',
    line({ ...PUSHED, ts: '2026-09-25T09:00:00.000Z' }),
    'it carries ts, which the run stamps',
  ],
  ['a line that carries runId', line({ ...PUSHED, runId: ENVELOPE.runId }), 'it carries runId, which the run stamps'],
  ['a line that carries key', line({ ...PUSHED, key: 'spec#1' }), 'it carries key, which the run stamps'],
  [
    'a line with no type',
    line({ branch: 'sail/FAKE-1' }),
    'its type is missing: it is no ticket:* or codehost:* event',
  ],
  ['a type that is no string', line({ type: 7 }), 'its type 7 is no ticket:* or codehost:* event'],
  [
    "an event of the run's own",
    line({ type: 'run:end', status: 'completed', replays: 1 }),
    'its type "run:end" is no ticket:* or codehost:* event',
  ],
  [
    'a workspace event',
    line({ type: 'workspace:released', path: '/tmp/x', kept: false }),
    'its type "workspace:released" is no ticket:* or codehost:* event',
  ],
  [
    'a codehost type the schema does not know',
    line({ type: 'codehost:deleted', number: 5 }),
    '/type must be equal to one of the allowed values',
  ],
  [
    'an event that lacks a required field',
    line({ type: 'codehost:pushed', branch: 'sail/FAKE-1' }),
    '/headSha is required',
  ],
  ['an event with a field of the wrong type', line({ ...LABELLED, number: '5' }), '/number must be integer'],
  ['an event with a field its type does not have', line({ ...PUSHED, force: true }), '/force is not allowed'],
])(
  '%s is no provider event: the line is named with why, and the valid lines before and after it are still read',
  (_, bad, why) => {
    const path = eventsFile();
    writeFileSync(path, `${line(PUSHED)}${bad}${line(LABELLED)}`);
    expect(readPortEvents(path, ENVELOPE)).toEqual({ events: [PUSHED, LABELLED], problems: [problem(2, why)] });
  },
);

test('every bad line is a problem of its own, numbered by its place in the file', () => {
  const path = eventsFile();
  writeFileSync(path, `nope\n${line(PUSHED)}${line({ ...LABELLED, key: 'open#1' })}`);
  expect(readPortEvents(path, ENVELOPE)).toEqual({
    events: [PUSHED],
    problems: [problem(1, 'it is not JSON'), problem(3, 'it carries key, which the run stamps')],
  });
});

test('a last line with no newline is dropped, whatever it holds: a child was killed while writing it', () => {
  const path = eventsFile();
  const whole = JSON.stringify(LABELLED);
  for (const tail of [whole, whole.slice(0, 20), 'nope']) {
    writeFileSync(path, `${line(PUSHED)}${tail}`);
    expect(readPortEvents(path, ENVELOPE)).toEqual({ events: [PUSHED], problems: [] });
  }
  writeFileSync(path, whole);
  expect(readPortEvents(path, ENVELOPE)).toEqual({ events: [], problems: [] });
});

test("a file that can't be read is one problem, naming why", () => {
  const path = eventsFile();
  mkdirSync(path);
  expect(readPortEvents(path, ENVELOPE)).toEqual({
    events: [],
    problems: ["port-events.ndjson can't be read (EISDIR)"],
  });
});

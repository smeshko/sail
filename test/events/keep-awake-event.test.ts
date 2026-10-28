// run:keep_awake in sail.event.v1 and in the terminal view: the run's own event, with no key and a closed payload, which
// prints from verbose.
import { expect, test } from 'bun:test';
import { validateDocument } from '../../src/engine/schemas';
import { type TerminalOptions, terminalConsumer, type Verbosity } from '../../src/events/consumers/terminal';
import type { NewEvent, SailEvent } from '../../src/events/types';
import { runEnd, runStart, stamp } from '../helpers/events';

const envelope = { seq: 3, ts: '2026-10-23T09:00:00.000Z', runId: 'FAKE-1-01M3BWNZM08Q4T6V2XRJ5KWD3N' };
const held = { ...envelope, type: 'run:keep_awake', held: true, by: 'caffeinate' };
const none = { ...envelope, type: 'run:keep_awake', held: false, reason: 'no keep-awake on linux' };

const paths = (event: Record<string, unknown>): string[] =>
  validateDocument('sail.event.v1', event).map((issue) => issue.path);

test('a held run:keep_awake names who holds it and a refused one its reason; a mix of the two, a key or an empty reason is refused', () => {
  const { by: _by, ...heldNoBy } = held;
  const { reason: _reason, ...noneNoReason } = none;
  expect({
    held: paths(held),
    none: paths(none),
    heldWithReason: paths({ ...held, reason: 'x' }).length > 0,
    noneWithBy: paths({ ...none, by: 'caffeinate' }).length > 0,
    heldNoBy: paths(heldNoBy).length > 0,
    noneNoReason: paths(noneNoReason).length > 0,
    key: paths({ ...held, key: 'spec#1' }),
    emptyReason: paths({ ...none, reason: '' }),
  }).toEqual({
    held: [],
    none: [],
    heldWithReason: true,
    noneWithBy: true,
    heldNoBy: true,
    noneNoReason: true,
    key: ['/key'],
    emptyReason: ['/reason'],
  });
});

function render(events: readonly SailEvent[], verbosity: Verbosity, options: Partial<TerminalOptions> = {}): string {
  let out = '';
  const terminal = terminalConsumer({
    verbosity,
    write: (text) => {
      out += text;
    },
    runsDir: '/runs',
    shownRunsDir: '.sail-runs',
    ...options,
  });
  for (const event of events) terminal.onEvent(event);
  terminal.close();
  return out;
}

const keepAwakeLines = (out: string) => out.split('\n').filter((line) => line.includes('keep-awake'));

test('the terminal view prints the keep-awake line from verbose, held or not, and nothing at normal or quiet', () => {
  const run = (event: NewEvent) => stamp([0, runStart()], [100, event], [200, runEnd('completed', 1)]);
  const heldRun = run({ type: 'run:keep_awake', held: true, by: 'caffeinate' });
  const noneRun = run({ type: 'run:keep_awake', held: false, reason: 'caffeinate is not on the PATH' });
  const W = ''.padEnd(8);
  expect({
    verbose: keepAwakeLines(render(heldRun, 'verbose')),
    unavailable: keepAwakeLines(render(noneRun, 'verbose')),
    normal: keepAwakeLines(render(heldRun, 'normal')),
    quiet: keepAwakeLines(render(heldRun, 'quiet')),
  }).toEqual({
    verbose: [`${W}  keep-awake · held by caffeinate`],
    unavailable: [`${W}  keep-awake · none: caffeinate is not on the PATH`],
    normal: [],
    quiet: [],
  });
});

// The terminal view of a run's budget: the run's own warning, exceeded budget and raise print from normal, a step's own
// budget events only at trace, and the final block has a cost row against the budget as raised, a resume's included.
import { expect, test } from 'bun:test';
import { type TerminalOptions, terminalConsumer, type Verbosity } from '../../../src/events/consumers/terminal';
import type { NewEvent, SailEvent } from '../../../src/events/types';
import { runEnd, runStart, session, stamp, start } from '../../helpers/events';

/** Everything `events` print through a fresh terminal consumer in plain mode. */
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

/** The key column's width: the roster's longest first key, `intake#1`, as this run:start names no stage. */
const WIDTH = 8;

const at = (list: NewEvent[], from = 0): SailEvent[] =>
  stamp(...list.map((event, i): [number, NewEvent] => [(from + i) * 100, event])).map((event, i) => ({
    ...event,
    seq: from + i + 1,
  }));

const suspendedEnd: NewEvent = {
  type: 'run:end',
  status: 'suspended',
  stopReason: 'budget_exceeded',
  message: '$0.50 of its $0.50 used before implement#1: raise it with --raise-budget <usd>',
  replays: 3,
};

/** A run suspended over its $0.50: spec, then implement cut by the share it was handed. */
const SUSPENDED: NewEvent[] = [
  runStart({ maxUsd: 0.5 }),
  start('spec#1', { kind: 'agent' }),
  session('spec#1', { turns: 4, toolCalls: 0, denials: 0, usage: { costUsd: 0.3125 } }),
  { type: 'budget:warning', budget: 'usd', limit: 0.5, used: 0.4077 },
  { type: 'budget:exceeded', budget: 'usd', limit: 0.5, used: 0.5029 },
  { type: 'budget:exceeded', key: 'implement#1', budget: 'usd', limit: 0.1875, used: 0.1904 },
  session('implement#1', { outcome: 'error', turns: 2, toolCalls: 0, denials: 0, usage: { costUsd: 0.1904 } }),
  { type: 'run:suspended', stopReason: 'budget_exceeded', budget: 'usd', limit: 0.5, used: 0.5029 },
  suspendedEnd,
];

/** Its resume, raised by $5. */
const RESUMED: NewEvent[] = [
  { type: 'workspace:leased', remote: 'fake://origin', branch: 'sail/FAKE-1' },
  { type: 'budget:raised', usd: 5, budget: { maxUsd: 5.5 } },
  session('implement#1', { turns: 5, toolCalls: 0, denials: 0, usage: { costUsd: 0.476 } }),
  runEnd('completed', 1),
];

const linesOf = (out: string, ...starts: string[]) =>
  out.split('\n').filter((line) => starts.some((text) => line.trimStart().startsWith(text)));

test("the run's warning and exceeded budget print from normal and not at quiet, a step's own only at trace, and the final block's cost row is against the budget", () => {
  const list = at(SUSPENDED);
  const trace = render(list, 'trace');
  expect({
    normal: linesOf(render(list, 'normal'), '$ budget', 'cost', 'stop'),
    quiet: linesOf(render(list, 'quiet'), '$ budget'),
    trace: linesOf(trace, 'implement#1').filter((line) => line.includes('budget:exceeded')),
  }).toEqual({
    normal: [
      `${''.padEnd(WIDTH)}  $ budget usd at $0.41 of $0.50`,
      `${''.padEnd(WIDTH)}  $ budget usd exceeded: $0.50 of $0.50`,
      '  stop     budget_exceeded: $0.50 of its $0.50 used before implement#1: raise it with --raise-budget <usd>',
      '  cost     $0.50 of $0.50 (100.6%)',
    ],
    quiet: [],
    trace: [`${'implement#1'.padEnd(WIDTH)}  · budget:exceeded {"budget":"usd","limit":0.1875,"used":0.1904}`],
  });
});

test('a resume prints its raise, and its final block has the cost of the whole run against the raised budget', () => {
  const prior = at(SUSPENDED);
  const out = render(at(RESUMED, prior.length), 'normal', { prior });
  expect(linesOf(out, '$ budget', 'cost')).toEqual([
    `${''.padEnd(WIDTH)}  $ budget raised by $5.00: now $5.50`,
    '  cost     $0.98 of $5.50 (17.8%)',
  ]);
});

test('at trace, run:suspended prints its generic line, and budget:raised its own', () => {
  const prior = at(SUSPENDED);
  const suspended = render(prior, 'trace');
  const resumed = render(at(RESUMED, prior.length), 'trace', { prior });
  expect([...linesOf(suspended, '· run:suspended'), ...linesOf(resumed, '$ budget raised')]).toEqual([
    `${''.padEnd(WIDTH)}  · run:suspended {"stopReason":"budget_exceeded","budget":"usd","limit":0.5,"used":0.5029}`,
    `${''.padEnd(WIDTH)}  $ budget raised by $5.00: now $5.50`,
  ]);
});

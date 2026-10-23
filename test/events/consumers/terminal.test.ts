// The terminal consumer: FAKE-1 rendered at each verbosity against its golden view in test/fixtures/terminal/, which
// `bun run golden` generates with the same `renderView()`, then synthetic events for what FAKE-1 lacks: errors, tails,
// the final block's rows, the live line, colours, a resume, and what no run writes yet: a multi-step call, a validated
// file, and a session's tool calls and denials.
import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { renderView } from '../../../scripts/golden';
import type { JournalEntry } from '../../../src/engine/journal';
import {
  formatDuration,
  formatSize,
  type TerminalConsumer,
  type TerminalOptions,
  terminalConsumer,
  type Verbosity,
} from '../../../src/events/consumers/terminal';
import { EVENT_TYPES, type NewEvent, type SailEvent } from '../../../src/events/types';

const FIXTURES = join(import.meta.dir, '..', '..', 'fixtures');
const RUNS = join(FIXTURES, 'runs');
const FAKE_1 = 'FAKE-1-01M3BWNZM08Q4T6V2XRJ5KWD3N';
const RUN_ID = 'RUN-1';
const START = Date.parse('2026-09-29T10:00:00.000Z');
const CLEAR = '\r\x1b[2K';

/** FAKE-1's events, parsed from its events.ndjson line by line. */
function fake1(): SailEvent[] {
  return readFileSync(join(RUNS, FAKE_1, 'events.ndjson'), 'utf8')
    .trimEnd()
    .split('\n')
    .map((line) => JSON.parse(line) as SailEvent);
}

/** The golden view of FAKE-1 at `verbosity`. */
function golden(verbosity: Verbosity): string {
  return readFileSync(join(FIXTURES, 'terminal', `${verbosity}.txt`), 'utf8');
}

const REVIEW = { read: ['**'], write: ['$STAGE_OUT/**'], commands: ['git log *', 'git diff *'] };
const FAKE = { use: 'fake', origin: 'builtin' };

/**
 * A `run:start` written by hand: a `ticket-to-pr` whose last stage, `publish`, has two steps. Its roster's keys go up
 * to `publish#1/describe`, so the key column is 18 wide.
 */
function rosterStart(): NewEvent {
  const agent = (origin: string, model: string, output: string, produces: string) => ({
    kind: 'agent',
    origin: `repo:.sail/${origin}`,
    model,
    output,
    produces: [produces],
    permissions: REVIEW,
    budget: { maxTurns: 20, maxUsd: 1, maxMinutes: 5 },
  });
  const { origin: _origin, ...describe } = agent('', 'claude-sonnet-5', 'PrDescription', 'pr-body.md');
  return {
    type: 'run:start',
    source: { kind: 'ticket', ticketKey: 'FAKE-1', via: 'cli', forced: [] },
    workflow: { name: 'ticket-to-pr', version: 1, origin: 'repo:.sail/workflows/ticket-to-pr', sha256: '0'.repeat(64) },
    roster: {
      intake: { name: 'ticket', origin: 'builtin', output: 'TicketInput', produces: ['ticket.json', 'brief.md'] },
      stages: {
        implement: agent('stages/implement', 'claude-sonnet-5', 'ChangeSet', 'diff.patch'),
        publish: {
          origin: 'repo:.sail/workflows/ticket-to-pr/stages/publish',
          output: 'PrInfo',
          steps: [
            { step: 'describe', ...describe },
            { step: 'open', kind: 'script', output: 'PrInfo' },
          ],
        },
        'self-review': agent(
          'workflows/ticket-to-pr/stages/self-review',
          'claude-opus-5-5',
          'ReviewOutput',
          'review.md',
        ),
        spec: agent('workflows/ticket-to-pr/stages/spec', 'claude-opus-5-5', 'SpecOutput', 'spec.md'),
        tests: {
          kind: 'script',
          origin: 'repo:.sail/stages/tests',
          output: 'TestReport',
          produces: ['junit.xml'],
          exitCodes: { passed: [0], failed: [1] },
        },
      },
    },
    adapters: { ticketSource: FAKE, codeHost: FAKE, harness: FAKE, workspace: FAKE },
    budget: { maxUsd: 25, maxMinutes: 90 },
  } as NewEvent;
}

/** Stamps `events` as a bus would: `seq` from 1, and `ts` 100 ms apart from START. */
function stream(events: readonly NewEvent[], runId = RUN_ID): SailEvent[] {
  return events.map(
    (event, index) =>
      ({ seq: index + 1, ts: new Date(START + index * 100).toISOString(), runId, ...event }) as SailEvent,
  );
}

/** A head line and a detail line of the terminal view, in a key column `width` wide. */
const head = (key: string, text: string, width = 12) => `${key.padEnd(width)}  ${text}`;
const detail = (key: string, text: string, width = 12) => `${key.padEnd(width)}    ${text}`;
const view = (...lines: string[]) => `${lines.join('\n')}\n`;

/** Everything `events` print through a fresh terminal consumer in plain mode. */
function render(events: readonly SailEvent[], verbosity: Verbosity, options: Partial<TerminalOptions> = {}): string {
  let out = '';
  const terminal = terminalConsumer({
    verbosity,
    write: (text) => {
      out += text;
    },
    runsDir: RUNS,
    shownRunsDir: '.sail-runs',
    ...options,
  });
  for (const event of events) terminal.onEvent(event);
  return out;
}

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A runs directory holding `files`, each relative to the run RUN-1's directory. */
function runsWith(files: Record<string, string>): string {
  const runs = mkdtempSync(join(tmpdir(), 'sail-terminal-'));
  dirs.push(runs);
  for (const [path, text] of Object.entries(files)) {
    const file = join(runs, RUN_ID, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, text);
  }
  return runs;
}

const stageStart = (key: string, kind: 'agent' | 'script' | 'stage' = 'script', extra = {}): NewEvent => {
  const [stage = '', call = '1'] = key.split('#');
  return { type: 'stage:start', key, stage, call: Number(call), try: 1, kind, consumed: {}, ...extra };
};

const stageEnd = (
  key: string,
  outcome: JournalEntry['outcome'],
  durationMs: number,
  resultPath: string,
  extra = {},
): NewEvent => {
  const [stage = '', call = '1'] = key.split('#');
  return { type: 'stage:end', key, stage, call: Number(call), try: 1, outcome, durationMs, resultPath, ...extra };
};

/** A terminal consumer in a 200-column terminal with a fake clock and timer, for the live line. */
function inTerminal(verbosity: Verbosity = 'quiet') {
  const timers = { ms: [] as number[], cancelled: 0, tick: (): void => undefined };
  let now = START;
  let out = '';
  const terminal: TerminalConsumer = terminalConsumer({
    verbosity,
    write: (text) => {
      out += text;
    },
    tty: { columns: () => 200 },
    runsDir: RUNS,
    shownRunsDir: '.sail-runs',
    now: () => now,
    every: (ms, tick) => {
      timers.ms.push(ms);
      timers.tick = tick;
      return () => {
        timers.cancelled++;
      };
    },
  });
  return {
    terminal,
    timers,
    advance: (ms: number) => {
      now += ms;
    },
    get out() {
      return out;
    },
  };
}

/**
 * The live line's text as the terminal shows it once `out` is written, or undefined when none is drawn: what follows the
 * last newline and the last clear, without its escape codes and spinner frame.
 */
function visibleLive(out: string): string | undefined {
  const last = out.slice(out.lastIndexOf('\n') + 1);
  if (!last.includes(CLEAR)) return last === '' ? undefined : last;
  const drawn = last.slice(last.lastIndexOf(CLEAR) + CLEAR.length);
  if (drawn === '') return undefined;
  const text = drawn.indexOf(' \x1b[2m');
  if (text === -1) return drawn;
  return drawn.slice(text + ' \x1b[2m'.length, drawn.endsWith('\x1b[0m') ? -'\x1b[0m'.length : undefined);
}

// TASK-003: quiet and normal.

test.each(['quiet', 'normal', 'verbose', 'trace'] as const)(
  'FAKE-1 at %s equals its golden view, byte for byte',
  (verbosity) => {
    expect(renderView(fake1(), verbosity)).toBe(golden(verbosity));
  },
);

test('quiet prints an error end with its duration and each message, a later line indented two more, and no tail', () => {
  const runs = runsWith({ '03-tests/call-1/stdout.log': 'a tail quiet leaves out\n' });
  const events = stream([
    stageStart('tests#1'),
    { type: 'script:exit', key: 'tests#1', code: 2, durationMs: 30, stdoutBytes: 24 },
    stageEnd('tests#1', 'error', 40, '03-tests/call-1/result.json', {
      errors: [
        { reason: 'exit_code', message: 'exit code 2 is not mapped to passed or failed' },
        { reason: 'invalid_output', message: "the output doesn't match its schema:\n/total must be integer" },
      ],
    }),
  ]);
  expect(render(events, 'quiet', { runsDir: runs })).toBe(
    view(
      head('tests#1', '✗ error · 40ms'),
      detail('tests#1', 'exit_code: exit code 2 is not mapped to passed or failed'),
      detail('tests#1', "invalid_output: the output doesn't match its schema:"),
      detail('tests#1', '  /total must be integer'),
    ),
  );
});

test.each(['quiet', 'normal'] as const)(
  'at %s, crashes, consumer failures and other errors each print their message',
  (verbosity) => {
    const events = stream([
      { type: 'error:crash', message: 'journal.ndjson:1 is not valid JSON', key: 'spec#1' },
      { type: 'error:crash', message: 'out of memory' },
      {
        type: 'error:consumer',
        consumer: 'summary.json',
        failed: { seq: 12, type: 'stage:end' },
        message: 'disk full',
      },
      { type: 'error:harness', key: 'spec#1', message: 'session lost' },
      // As an events file may hold it: an adapter's own fields, and no message.
      { type: 'error:harness', key: 'spec#1', adapter: 'fake', code: 7 } as unknown as NewEvent,
    ]);
    // Each through a consumer of its own, so no error can stop the ones after it from printing.
    expect(events.map((event) => render([event], verbosity)).join('')).toBe(
      view(
        head('spec#1', '✗ crash: journal.ndjson:1 is not valid JSON'),
        head('', '✗ crash: out of memory'),
        head('', '✗ consumer summary.json failed on stage:end #12: disk full'),
        head('spec#1', '✗ error:harness: session lost'),
        head('spec#1', '✗ error:harness {"adapter":"fake","code":7}'),
      ),
    );
  },
);

test('a message prints no blank line of its own, and an empty one leaves no trailing space', () => {
  const events = stream([
    { type: 'error:crash', message: 'a\n\n  \nb\n' },
    { type: 'error:crash', message: '' },
    { type: 'error:consumer', consumer: 'x', failed: { seq: 3, type: 'stage:end' }, message: '' },
    { type: 'error:harness', key: 'spec#1', message: '' },
  ]);
  expect(events.map((event) => render([event], 'quiet')).join('')).toBe(
    view(
      head('', '✗ crash: a'),
      detail('', '  b'),
      head('', '✗ crash:'),
      head('', '✗ consumer x failed on stage:end #3:'),
      head('spec#1', '✗ error:harness:'),
    ),
  );
});

test('a timeout prints nothing of its own below trace, and an invalid output prints only its verdict', () => {
  const events = stream([
    { type: 'error:timeout', key: 'tests#1', message: 'timed out after 30s', timeoutSeconds: 30 },
    { type: 'output:invalid', key: 'tests#2', message: 'the last stdout line is not JSON: Unexpected token' },
  ]);
  expect({ quiet: render(events, 'quiet'), normal: render(events, 'normal') }).toEqual({
    quiet: '',
    normal: view(detail('tests#2', 'output invalid')),
  });
});

test('normal shows an unmapped exit, a signal, a second try and a blocked outcome as such', () => {
  const events = stream([
    stageStart('tests#1'),
    { type: 'script:exit', key: 'tests#1', code: 2, durationMs: 40, stdoutBytes: 0 },
    stageStart('tests#2', 'script', { try: 2 }),
    { type: 'script:exit', key: 'tests#2', code: null, signal: 'SIGTERM', durationMs: 1234, stdoutBytes: 0 },
    stageEnd('review#1', 'blocked', 3000, '04-review/call-1/result.json'),
  ]);
  expect(render(events, 'normal')).toBe(
    view(
      head('tests#1', '▶ tests · script'),
      detail('tests#1', 'exit 2 · 40ms'),
      head('tests#2', '▶ tests · script · try 2'),
      detail('tests#2', 'ended by SIGTERM · 1.2s'),
      head('review#1', '⊘ blocked · 3.0s'),
    ),
  );
});

test('loop lines name feedback from the workflow or an unknown pointer as given, and an exceeded loop', () => {
  const events = stream([
    { type: 'loop:iteration', loop: 'fix', iteration: 2, max: 3, feedback: { from: 'workflow' } },
    {
      type: 'loop:iteration',
      loop: 'review',
      iteration: 2,
      max: 2,
      feedback: { from: '09-review/call-9/result.json#/output' },
    },
    { type: 'loop:exit', loop: 'fix', iterations: 3, max: 3, reason: 'exceeded' },
  ]);
  expect(render(events, 'normal')).toBe(
    view(
      head('fix', '↻ iteration 2/3 · feedback from the workflow'),
      head('review', '↻ iteration 2/2 · feedback from 09-review/call-9/result.json#/output'),
      head('fix', '✗ exceeded 3/3'),
    ),
  );
});

test('a script that ends in error shows the last 10 non-blank lines of stdout.log, then stderr.log, and a missing call directory shows none', () => {
  const stdout = ['line 1', 'line 2', 'line 3', 'line 4', 'line 5', 'line 6', '', 'line 7', 'line 8', 'line 9'];
  const runs = runsWith({
    '03-tests/call-1/stdout.log': `${[...stdout, 'line 10', 'line 11', 'line 12', ''].join('\n')}\n`,
    '03-tests/call-1/stderr.log': 'warn: slow\n',
  });
  const events = stream([
    stageStart('tests#1'),
    stageEnd('tests#1', 'error', 40, '03-tests/call-1/result.json', {
      errors: [{ reason: 'exit_code', message: 'exit code 2 is not mapped to passed or failed' }],
    }),
    stageStart('tests#2'),
    stageEnd('tests#2', 'failed', 2540, '03-tests/call-2/result.json'),
  ]);
  expect(render(events, 'normal', { runsDir: runs })).toBe(
    view(
      head('tests#1', '▶ tests · script'),
      head('tests#1', '✗ error · 40ms'),
      detail('tests#1', 'exit_code: exit code 2 is not mapped to passed or failed'),
      detail('tests#1', 'stdout.log · last 10 lines'),
      ...['3', '4', '5', '6', '7', '8', '9', '10', '11', '12'].map((n) => detail('tests#1', `│ line ${n}`)),
      detail('tests#1', 'stderr.log'),
      detail('tests#1', '│ warn: slow'),
      head('tests#2', '▶ tests · script'),
      head('tests#2', '✗ failed · 2.5s'),
    ),
  );
});

test('a tail reads the last 64 KiB: a line the window starts inside is dropped, and one it starts on is kept', () => {
  // stdout.log's window starts just after a newline, on the A line. stderr.log's starts inside its long y line.
  const a = 'A'.repeat(65533);
  const runs = runsWith({
    '03-tests/call-1/stdout.log': `${'x'.repeat(100)}\n${a}\nB\n`,
    '03-tests/call-1/stderr.log': `${'y'.repeat(65540)}\nC\nD\n`,
  });
  const events = stream([stageStart('tests#1'), stageEnd('tests#1', 'failed', 40, '03-tests/call-1/result.json')]);
  expect(render(events, 'normal', { runsDir: runs })).toBe(
    view(
      head('tests#1', '▶ tests · script'),
      head('tests#1', '✗ failed · 40ms'),
      detail('tests#1', 'stdout.log · last 2 lines'),
      detail('tests#1', `│ ${a}`),
      detail('tests#1', '│ B'),
      detail('tests#1', 'stderr.log · last 2 lines'),
      detail('tests#1', '│ C'),
      detail('tests#1', '│ D'),
    ),
  );
});

test('a tail line that holds only escape codes is blank, and a tail line never ends in whitespace', () => {
  const runs = runsWith({
    '03-tests/call-1/stdout.log': 'ok 1\n\x1b[0m\n\x1b[2K\nok 2 \x1b[0m\n\x1b[32m\x1b[0m\r\n',
  });
  const events = stream([stageStart('tests#1'), stageEnd('tests#1', 'failed', 40, '03-tests/call-1/result.json')]);
  expect(render(events, 'normal', { runsDir: runs })).toBe(
    view(
      head('tests#1', '▶ tests · script'),
      head('tests#1', '✗ failed · 40ms'),
      detail('tests#1', 'stdout.log'),
      detail('tests#1', '│ ok 1'),
      detail('tests#1', '│ ok 2'),
    ),
  );
});

test.each<[string, NewEvent[], string]>([
  [
    'a failed run names its stop, counts outcomes in order and keeps each loop at its highest',
    [
      rosterStart(),
      { type: 'journal:append', key: 'tests#1', line: 1, outcome: 'failed' },
      { type: 'journal:append', key: 'review#1', line: 2, outcome: 'blocked' },
      { type: 'journal:append', key: 'publish#1/open', line: 3, outcome: 'passed' },
      { type: 'journal:append', key: 'spec#1', line: 4, outcome: 'passed' },
      { type: 'journal:append', key: 'tests#2', line: 5, outcome: 'error' },
      { type: 'loop:iteration', loop: 'fix', iteration: 1, max: 3 },
      { type: 'loop:iteration', loop: 'review', iteration: 1, max: 2 },
      { type: 'loop:iteration', loop: 'fix', iteration: 2, max: 3 },
      { type: 'loop:iteration', loop: 'fix', iteration: 2, max: 3 },
      { type: 'loop:iteration', loop: 'fix', iteration: 3, max: 3 },
      { type: 'loop:exit', loop: 'fix', iterations: 3, max: 3, reason: 'exceeded' },
      {
        type: 'run:end',
        status: 'failed',
        stopReason: 'workflow_failed',
        message: 'loop "fix" exceeded 3',
        replays: 6,
      },
    ],
    view(
      'sail · ticket-to-pr v1 · RUN-1',
      '',
      'failed · 1.2s',
      '  stop     workflow_failed: loop "fix" exceeded 3',
      '  calls    4 · 1 passed, 1 failed, 1 blocked, 1 error',
      '  loops    fix 3/3, review 1/2',
      '  replays  6',
      '  run      .sail-runs/RUN-1',
    ),
  ],
  [
    'a suspended run with no call and no loop has calls 0 and no loops row',
    [
      rosterStart(),
      {
        type: 'run:end',
        status: 'suspended',
        stopReason: 'interrupted',
        message: 'stopped during implement#2',
        replays: 1,
      },
    ],
    view(
      'sail · ticket-to-pr v1 · RUN-1',
      '',
      'suspended · 100ms',
      '  stop     interrupted: stopped during implement#2',
      '  calls    0',
      '  replays  1',
      '  run      .sail-runs/RUN-1',
    ),
  ],
])('the final block: %s', (_, events, expected) => {
  expect(render(stream(events), 'quiet')).toBe(expected);
});

test("the final block's stop row puts a message's later lines under its value, indented two more", () => {
  const events = stream([
    rosterStart(),
    {
      type: 'run:end',
      status: 'failed',
      stopReason: 'stage_error',
      message: "tests#1 ended in error: invalid_output: the output doesn't match its schema:\n/total must be integer\n",
      replays: 0,
    },
  ]);
  expect(render(events, 'quiet')).toBe(
    view(
      'sail · ticket-to-pr v1 · RUN-1',
      '',
      'failed · 100ms',
      "  stop     stage_error: tests#1 ended in error: invalid_output: the output doesn't match its schema:",
      `${' '.repeat(13)}/total must be integer`,
      '  calls    0',
      '  replays  0',
      '  run      .sail-runs/RUN-1',
    ),
  );
});

test.each<[number, string]>([
  [0, '0ms'],
  [999, '999ms'],
  [1450, '1.5s'],
  [2450, '2.5s'],
  [10405, '10.4s'],
  [59949, '59.9s'],
  [59950, '1m 0s'],
  [119600, '2m 0s'],
  [3599499, '59m 59s'],
  [3600000, '1h 0m'],
  [7322000, '2h 2m'],
])('formatDuration(%p) is %p', (ms, text) => {
  expect(formatDuration(ms)).toBe(text);
});

test('in a terminal, the live line names the running call and its elapsed seconds, and follows a step and back', () => {
  const t = inTerminal();
  const [start, stepStart, stepEnd, end] = stream([
    stageStart('publish#1', 'stage', { steps: ['open'] }),
    {
      type: 'step:start',
      key: 'publish#1/open',
      stage: 'publish',
      step: 'open',
      index: 1,
      of: 1,
      kind: 'script',
      try: 1,
    },
    {
      type: 'step:end',
      key: 'publish#1/open',
      step: 'open',
      try: 1,
      outcome: 'passed',
      resultPath: '05-publish/call-1/steps/1-open/result.json',
    },
    stageEnd('publish#1', 'passed', 75900, '05-publish/call-1/result.json'),
  ]) as [SailEvent, SailEvent, SailEvent, SailEvent];

  t.terminal.onEvent(start);
  expect({ live: visibleLive(t.out), timers: t.timers.ms }).toEqual({ live: 'publish#1 running · 0s', timers: [100] });
  t.advance(12_900);
  t.timers.tick();
  expect(visibleLive(t.out)).toBe('publish#1 running · 12s');

  t.terminal.onEvent(stepStart);
  t.timers.tick();
  expect(visibleLive(t.out)).toBe('publish#1/open running · 0s');
  t.advance(63_000);
  t.timers.tick();
  expect(visibleLive(t.out)).toBe('publish#1/open running · 1m 3s');

  t.terminal.onEvent(stepEnd);
  t.timers.tick();
  expect(visibleLive(t.out)).toBe('publish#1 running · 1m 15s');

  t.terminal.onEvent(end);
  expect({ live: visibleLive(t.out), timers: t.timers.ms, cancelled: t.timers.cancelled }).toEqual({
    live: undefined,
    timers: [100],
    cancelled: 1,
  });
  const ended = t.out;
  t.timers.tick();
  expect(t.out).toBe(ended);
});

test.each<[string, NewEvent | undefined]>([
  ['run:end', { type: 'run:end', status: 'completed', replays: 1 }],
  ['error:crash', { type: 'error:crash', key: 'implement#2', message: 'boom' }],
  ['close()', undefined],
])('in a terminal, %s leaves no live line and no timer', (_, ending) => {
  const t = inTerminal();
  const [start, last] = stream([
    stageStart('implement#2'),
    ending ?? { type: 'journal:append', key: 'implement#1', line: 1, outcome: 'done' },
  ]) as [SailEvent, SailEvent];
  t.terminal.onEvent(start);
  expect(visibleLive(t.out)).toBe('implement#2 running · 0s');
  if (ending === undefined) t.terminal.close();
  else t.terminal.onEvent(last);
  expect({ live: visibleLive(t.out), cancelled: t.timers.cancelled }).toEqual({ live: undefined, cancelled: 1 });
});

test('in a terminal, a stage that ends while a step of its own runs takes the step off the live line too', () => {
  const t = inTerminal();
  const events = stream([
    stageStart('publish#1', 'stage', { steps: ['open'] }),
    {
      type: 'step:start',
      key: 'publish#1/open',
      stage: 'publish',
      step: 'open',
      index: 1,
      of: 1,
      kind: 'script',
      try: 1,
    },
    stageEnd('publish#1', 'error', 900, '05-publish/call-1/result.json'),
  ]);
  for (const event of events) t.terminal.onEvent(event);
  expect({ live: visibleLive(t.out), cancelled: t.timers.cancelled }).toEqual({ live: undefined, cancelled: 1 });
});

test('in a terminal, a pass is green, a failure yellow and an error red', () => {
  const t = inTerminal('normal');
  const events = stream([
    stageStart('tests#1'),
    stageEnd('tests#1', 'passed', 1000, '03-tests/call-1/result.json'),
    stageStart('tests#2'),
    stageEnd('tests#2', 'failed', 1000, '03-tests/call-2/result.json'),
    stageStart('tests#3'),
    stageEnd('tests#3', 'error', 1000, '03-tests/call-3/result.json', {
      errors: [{ reason: 'exit_code', message: 'exit code 2 is not mapped to passed or failed' }],
    }),
  ]);
  for (const event of events) t.terminal.onEvent(event);
  expect(t.out).toContain('\x1b[32m✓');
  expect(t.out).toContain('\x1b[33m✗');
  expect(t.out).toContain('\x1b[31m✗');
});

// TASK-004: verbose and trace.

test('at trace, an event of every type prints a line of its own', () => {
  const w = 18;
  const cases: [NewEvent, string][] = [
    [rosterStart(), 'sail · ticket-to-pr v1 · RUN-1'],
    [
      { type: 'intake:start', key: 'intake#1', intake: 'ticket', kind: 'script', origin: 'builtin', consumed: {} },
      head('intake#1', '▶ intake ticket · script', w),
    ],
    [
      { type: 'intake:end', key: 'intake#1', outcome: 'passed', resultPath: '00-intake/call-1/result.json' },
      head('intake#1', '✓ passed', w),
    ],
    [stageStart('tests#1'), head('tests#1', '▶ tests · script', w)],
    [stageEnd('tests#1', 'done', 2500, '03-tests/call-1/result.json'), head('tests#1', '✓ done · 2.5s', w)],
    [
      {
        type: 'step:start',
        key: 'publish#1/open',
        stage: 'publish',
        step: 'open',
        index: 2,
        of: 2,
        kind: 'script',
        try: 1,
      },
      head('publish#1/open', '▶ open · step 2/2 · script', w),
    ],
    [
      {
        type: 'step:end',
        key: 'publish#1/open',
        step: 'open',
        try: 1,
        outcome: 'failed',
        resultPath: '05-publish/call-1/steps/2-open/result.json',
      },
      head('publish#1/open', '✗ failed', w),
    ],
    [{ type: 'loop:iteration', loop: 'fix', iteration: 1, max: 3 }, head('fix', '↻ iteration 1/3', w)],
    [{ type: 'loop:exit', loop: 'fix', iterations: 1, max: 3, reason: 'break' }, head('fix', '↻ break after 1/3', w)],
    [{ type: 'workflow:route', at: 'tests#1', value: 'passed', took: 'end' }, head('tests#1', '→ end · on passed', w)],
    [{ type: 'journal:append', key: 'tests#1', line: 1, outcome: 'done' }, detail('tests#1', 'journal line 1', w)],
    [{ type: 'agent:message', key: 'spec#1', text: 'hi' }, head('spec#1', '· agent:message {"text":"hi"}', w)],
    [{ type: 'agent:thinking', key: 'spec#1', text: 'hm' }, head('spec#1', '· agent:thinking {"text":"hm"}', w)],
    // The harness families are closed, so each sample carries its whole payload.
    [
      { type: 'harness:session_start', key: 'spec#1', adapter: 'fake', sessionId: 's-1', model: 'm' },
      head('spec#1', '· harness:session_start {"adapter":"fake","sessionId":"s-1","model":"m"}', w),
    ],
    [
      {
        type: 'harness:session_end',
        key: 'spec#1',
        outcome: 'done',
        reason: 'submitted',
        turns: 1,
        toolCalls: 0,
        denials: 0,
        usage: { costUsd: 0 },
      },
      head(
        'spec#1',
        '· harness:session_end {"outcome":"done","reason":"submitted","turns":1,"toolCalls":0,"denials":0,"usage":{"costUsd":0}}',
        w,
      ),
    ],
    [
      { type: 'tool:start', key: 'spec#1', callId: 'tool-1', tool: 'Read', input: {} },
      head('spec#1', '· tool:start {"callId":"tool-1","tool":"Read","input":{}}', w),
    ],
    [
      { type: 'tool:end', key: 'spec#1', callId: 'tool-1', status: 'completed', durationMs: 40 },
      head('spec#1', '· tool:end {"callId":"tool-1","status":"completed","durationMs":40}', w),
    ],
    [
      {
        type: 'permission:denied',
        key: 'spec#1',
        callId: 'tool-1',
        tool: 'Bash',
        rule: 'commands',
        permissions: { commands: [] },
        reason: 'no',
      },
      head(
        'spec#1',
        '· permission:denied {"callId":"tool-1","tool":"Bash","rule":"commands","permissions":{"commands":[]},"reason":"no"}',
        w,
      ),
    ],
    [
      { type: 'script:exec', key: 'tests#1', command: 'run.sh', cwd: '.', envKeys: [] },
      detail('tests#1', '$ run.sh', w),
    ],
    [
      { type: 'script:exit', key: 'tests#1', code: 0, outcome: 'passed', durationMs: 900, stdoutBytes: 3 },
      detail('tests#1', 'exit 0 → passed · 900ms', w),
    ],
    [
      { type: 'input:materialised', key: 'tests#1', binding: 'spec', from: '01-spec/call-1/spec.md' },
      detail('tests#1', 'in spec ← 01-spec/call-1/spec.md', w),
    ],
    [
      {
        type: 'prompt:rendered',
        key: 'spec#1',
        try: 1,
        path: '01-spec/call-1/prompt.md',
        untrusted: 0,
        fragments: [],
        conventions: [],
      },
      head(
        'spec#1',
        '· prompt:rendered {"try":1,"path":"01-spec/call-1/prompt.md","untrusted":0,"fragments":[],"conventions":[]}',
        w,
      ),
    ],
    [{ type: 'output:validated', key: 'tests#1' }, detail('tests#1', 'output valid', w)],
    [{ type: 'output:invalid', key: 'tests#2', message: 'bad' }, detail('tests#2', 'output invalid', w)],
    [
      {
        type: 'file:produced',
        key: 'tests#1',
        name: 'junit.xml',
        path: '03-tests/call-1/junit.xml',
        bytes: 893,
        sha256: 'ab',
      },
      detail('tests#1', 'file junit.xml · 893 B', w),
    ],
    [
      { type: 'file:validated', key: 'tests#1', name: 'junit.xml', ok: false, checks: ['wellFormed'] },
      detail('tests#1', 'file junit.xml invalid · wellFormed', w),
    ],
    [
      {
        type: 'usage:update',
        key: 'spec#1',
        turn: 1,
        tokens: { input: 1, cacheRead: 0, cacheWrite: 0, output: 2 },
        costUsdSoFar: 0.5,
      },
      head(
        'spec#1',
        '· usage:update {"turn":1,"tokens":{"input":1,"cacheRead":0,"cacheWrite":0,"output":2},"costUsdSoFar":0.5}',
        w,
      ),
    ],
    [
      { type: 'budget:warning', key: 'spec#1', budget: 'usd', limit: 5, used: 4 },
      head('spec#1', '· budget:warning {"budget":"usd","limit":5,"used":4}', w),
    ],
    [
      { type: 'budget:exceeded', key: 'spec#1', budget: 'usd', limit: 5, used: 6 },
      head('spec#1', '· budget:exceeded {"budget":"usd","limit":5,"used":6}', w),
    ],
    // The provider families are closed, so each sample carries its whole payload.
    [
      {
        type: 'ticket:fetched',
        ticketKey: 'FAKE-1',
        title: 'Add a flag',
        url: 'fake://tickets/FAKE-1',
        comments: 1,
        links: 0,
        attachments: 0,
        durationMs: 310,
      },
      head(
        '',
        '· ticket:fetched {"ticketKey":"FAKE-1","title":"Add a flag","url":"fake://tickets/FAKE-1","comments":1,"links":0,"attachments":0,"durationMs":310}',
        w,
      ),
    ],
    [
      { type: 'ticket:claimed', ticketKey: 'FAKE-1', state: { type: 'started', name: 'In Progress' } },
      head('', '· ticket:claimed {"ticketKey":"FAKE-1","state":{"type":"started","name":"In Progress"}}', w),
    ],
    [
      {
        type: 'ticket:updated',
        ticketKey: 'FAKE-1',
        change: { state: 'done' },
        state: { type: 'completed', name: 'Done' },
      },
      head(
        '',
        '· ticket:updated {"ticketKey":"FAKE-1","change":{"state":"done"},"state":{"type":"completed","name":"Done"}}',
        w,
      ),
    ],
    [
      { type: 'ticket:commented', ticketKey: 'FAKE-1', body: 'hi' },
      head('', '· ticket:commented {"ticketKey":"FAKE-1","body":"hi"}', w),
    ],
    [
      { type: 'codehost:pushed', branch: 'sail/FAKE-1', headSha: 'b4efb0c' },
      head('', '· codehost:pushed {"branch":"sail/FAKE-1","headSha":"b4efb0c"}', w),
    ],
    [
      { type: 'codehost:pr_opened', number: 1, url: 'pr/1', draft: false, base: 'main', head: 'sail/FAKE-1' },
      head('', '· codehost:pr_opened {"number":1,"url":"pr/1","draft":false,"base":"main","head":"sail/FAKE-1"}', w),
    ],
    [
      { type: 'codehost:checks', number: 1, headSha: 'b4efb0c', checks: [{ name: 'ci', status: 'passed' }] },
      head('', '· codehost:checks {"number":1,"headSha":"b4efb0c","checks":[{"name":"ci","status":"passed"}]}', w),
    ],
    [
      { type: 'codehost:labelled', number: 1, label: 'sail', change: 'added' },
      head('', '· codehost:labelled {"number":1,"label":"sail","change":"added"}', w),
    ],
    [
      { type: 'codehost:commented', number: 1, body: 'hi' },
      head('', '· codehost:commented {"number":1,"body":"hi"}', w),
    ],
    [
      { type: 'codehost:merged', number: 1, method: 'squash', sha: 'f569e7f' },
      head('', '· codehost:merged {"number":1,"method":"squash","sha":"f569e7f"}', w),
    ],
    [
      { type: 'workspace:leased', remote: 'origin', branch: 'sail/FAKE-1' },
      head('', '· workspace:leased {"remote":"origin","branch":"sail/FAKE-1"}', w),
    ],
    [
      { type: 'workspace:lease_released', remote: 'origin', branch: 'sail/FAKE-1' },
      head('', '· workspace:lease_released {"remote":"origin","branch":"sail/FAKE-1"}', w),
    ],
    [
      { type: 'workspace:created', path: 'ws', branch: 'sail/FAKE-1', baseSha: 'f569e7f', durationMs: 640 },
      head('', '· workspace:created {"path":"ws","branch":"sail/FAKE-1","baseSha":"f569e7f","durationMs":640}', w),
    ],
    [
      { type: 'workspace:released', path: 'ws', kept: false },
      head('', '· workspace:released {"path":"ws","kept":false}', w),
    ],
    [{ type: 'error:harness', key: 'spec#1', message: 'lost' }, head('spec#1', '✗ error:harness: lost', w)],
    [
      { type: 'error:timeout', key: 'tests#1', message: 'timed out after 30s', timeoutSeconds: 30 },
      head('tests#1', '· error:timeout {"message":"timed out after 30s","timeoutSeconds":30}', w),
    ],
    [
      { type: 'error:consumer', consumer: 'x', failed: { seq: 3, type: 'stage:end' }, message: 'm' },
      head('', '✗ consumer x failed on stage:end #3: m', w),
    ],
    [
      {
        type: 'error:port',
        key: 'merge#1',
        port: 'codeHost',
        op: 'merge',
        code: 'conflict',
        message: 'codeHost.merge: GitHub 405: Pull Request is not mergeable',
      },
      head('merge#1', '✗ error:port: codeHost.merge: GitHub 405: Pull Request is not mergeable', w),
    ],
    [{ type: 'run:end', status: 'completed', replays: 1 }, '  replays  1'],
    [{ type: 'error:crash', message: 'boom' }, head('', '✗ crash: boom', w)],
  ];
  // A group's two lines are their own test's, at every verbosity they print at.
  const grouped = new Set<string>(['all:start', 'all:end']);
  expect(cases.map(([event]) => event.type).sort()).toEqual(EVENT_TYPES.filter((type) => !grouped.has(type)).sort());

  const lines = render(stream(cases.map(([event]) => event)), 'trace').split('\n');
  const missing = cases.filter(([, line]) => !lines.includes(line)).map(([event, line]) => `${event.type}: ${line}`);
  expect(missing).toEqual([]);
});

test.each<[Verbosity, string]>([
  [
    'verbose',
    view(
      head('tests#1', '▶ tests · script'),
      detail('tests#1', 'ended by SIGTERM · 30.0s'),
      head('tests#1', '✗ error · 30.1s'),
      detail('tests#1', 'timeout: timed out after 30s'),
    ),
  ],
  [
    'trace',
    view(
      head('tests#1', '▶ tests · script'),
      detail('tests#1', 'ended by SIGTERM · 30.0s'),
      head('tests#1', '· error:timeout {"message":"timed out after 30s","timeoutSeconds":30}'),
      head('tests#1', '✗ error · 30.1s'),
      detail('tests#1', 'timeout: timed out after 30s'),
    ),
  ],
])(
  'at %s, a timeout message prints once through its call, and only trace adds the event itself',
  (verbosity, expected) => {
    const events = stream([
      stageStart('tests#1'),
      { type: 'script:exit', key: 'tests#1', code: null, signal: 'SIGTERM', durationMs: 30000, stdoutBytes: 0 },
      { type: 'error:timeout', key: 'tests#1', message: 'timed out after 30s', timeoutSeconds: 30 },
      stageEnd('tests#1', 'error', 30100, '03-tests/call-1/result.json', {
        errors: [{ reason: 'timeout', message: 'timed out after 30s' }],
      }),
    ]);
    expect(render(events, verbosity)).toBe(expected);
  },
);

test('verbose leaves the cwd off a command run in the workspace, and routes to the end or a fail', () => {
  const events = stream([
    { type: 'script:exec', key: 'tests#1', command: '.sail/stages/tests/run.sh', cwd: '.', envKeys: ['RUN_ID'] },
    { type: 'workflow:route', at: 'tests#1', value: 'passed', took: 'end' },
    { type: 'workflow:route', at: 'tests#2', value: 'failed', took: 'fail' },
  ]);
  expect(render(events, 'verbose')).toBe(
    view(
      detail('tests#1', '$ .sail/stages/tests/run.sh'),
      head('tests#1', '→ end · on passed'),
      head('tests#2', '→ fail · on failed'),
    ),
  );
});

test.each<[number, string]>([
  [0, '0 B'],
  [1023, '1023 B'],
  [1024, '1.0 KB'],
  [1034, '1.0 KB'],
  [1048575, '1.0 MB'],
  [2621440, '2.5 MB'],
])('formatSize(%p) is %p', (bytes, text) => {
  expect(formatSize(bytes)).toBe(text);
});

test('verbose shows the tail of a script that passed, and none for an agent call', () => {
  const runs = runsWith({
    '01-spec/call-1/stdout.log': 'agent chatter\n',
    '03-tests/call-1/stdout.log': 'ok 1\n',
  });
  const events = stream([
    stageStart('spec#1', 'agent'),
    stageEnd('spec#1', 'done', 1000, '01-spec/call-1/result.json'),
    stageStart('tests#1'),
    stageEnd('tests#1', 'passed', 1000, '03-tests/call-1/result.json'),
  ]);
  expect(render(events, 'verbose', { runsDir: runs })).toBe(
    view(
      head('spec#1', '▶ spec · agent'),
      head('spec#1', '✓ done · 1.0s'),
      head('tests#1', '▶ tests · script'),
      head('tests#1', '✓ passed · 1.0s'),
      detail('tests#1', 'stdout.log'),
      detail('tests#1', '│ ok 1'),
    ),
  );
});

// TASK-005: the whole run on resume.

/** The `seq` of the golden run's `journal:append` for tests#1: the last event of the process a resume takes over from. */
const RESUMED_AFTER = 52;

test('FAKE-1 resumed after tests#1 prints nothing for its earlier events, then opens with the resume line and ends with the whole run', () => {
  const events = fake1();
  let out = '';
  const terminal = terminalConsumer({
    verbosity: 'normal',
    write: (text) => {
      out += text;
    },
    runsDir: RUNS,
    shownRunsDir: '.sail-runs',
    prior: events.filter((event) => event.seq <= RESUMED_AFTER),
  });
  expect(out).toBe('');

  for (const event of events.filter((each) => each.seq > RESUMED_AFTER)) terminal.onEvent(event);
  const normal = golden('normal').split('\n');
  const resumedAt = normal.findIndex((line) => line.endsWith('↻ iteration 2/3 · feedback from tests#1'));
  expect(resumedAt).toBe(22);
  expect(out).toBe(
    [
      `sail · ticket-to-pr v1 · ${FAKE_1} · resumed after 4 calls, last tests#1 failed`,
      ...normal.slice(resumedAt),
    ].join('\n'),
  );
});

test('the final block adds up the replays of every run:end, earlier ones included', () => {
  const events = stream([
    rosterStart(),
    { type: 'journal:append', key: 'spec#1', line: 1, outcome: 'passed' },
    { type: 'journal:append', key: 'implement#1', line: 2, outcome: 'passed' },
    { type: 'run:end', status: 'suspended', stopReason: 'interrupted', message: 'stopped during tests#1', replays: 3 },
    { type: 'journal:append', key: 'tests#1', line: 3, outcome: 'passed' },
    { type: 'run:end', status: 'completed', replays: 5 },
  ]);
  expect(render(events.slice(4), 'quiet', { prior: events.slice(0, 4) })).toBe(
    view(
      'sail · ticket-to-pr v1 · RUN-1 · resumed after 2 calls, last implement#1 passed',
      '',
      'completed · 500ms',
      '  calls    3 · 3 passed',
      '  replays  8',
      '  run      .sail-runs/RUN-1',
    ),
  );
});

test('an earlier event the view cannot read is left out, and the resume still renders', () => {
  const [start, spec, next] = stream([
    { type: 'run:start' } as NewEvent,
    { type: 'journal:append', key: 'spec#1', line: 1, outcome: 'passed' },
    stageStart('implement#1'),
  ]) as [SailEvent, SailEvent, SailEvent];
  expect(render([next], 'normal', { prior: [start, spec] })).toBe(
    view('sail · RUN-1 · resumed after 1 call, last spec#1 passed', head('implement#1', '▶ implement · script')),
  );
});

test('with no earlier events, the resume line names the run from the first live event', () => {
  const events = stream([stageStart('spec#1')], 'RUN-9');
  expect(render(events, 'normal', { prior: [] })).toBe(
    view('sail · RUN-9 · resumed before its first call', head('spec#1', '▶ spec · script')),
  );
});

test('at trace, a ticket:fetched prints its title as JSON does: an escape character in it is printed escaped, never raw', () => {
  const title = 'Add \u001b[31mred\u001b[0m\r\nand a "quote"';
  const event: NewEvent = {
    type: 'ticket:fetched',
    key: 'intake#1',
    ticketKey: 'FAKE-1',
    title,
    url: 'fake://tickets/FAKE-1',
    comments: 0,
    links: 0,
    attachments: 0,
    durationMs: 5,
  };
  const printed = render(stream([event]), 'trace');
  expect(printed).toContain(
    '· ticket:fetched {"ticketKey":"FAKE-1","title":"Add \\u001b[31mred\\u001b[0m\\r\\nand a \\"quote\\"","url":"fake://tickets/FAKE-1","comments":0,"links":0,"attachments":0,"durationMs":5}',
  );
  expect([printed.includes('\u001b'), printed.includes('\r')]).toEqual([false, false]);
  for (const verbosity of ['quiet', 'normal', 'verbose'] as const) {
    expect(render(stream([event]), verbosity)).not.toContain('ticket:fetched');
  }
});

// What the golden run no longer shows (D9): the engine can't run a multi-step stage or a real harness yet, so these
// lines are held here, on events written by hand. Each expected line is the one the hand-written golden views had.

const DESCRIBE = 'publish#1/describe';
const OPEN = 'publish#1/open';
const DENIED = "'git push origin HEAD' matches none of the step's commands";

/** A two-step call: an agent step whose session calls three tools, one denied and one failed, then a script step. */
const TWO_STEP_CALL: NewEvent[] = [
  rosterStart(),
  stageStart('publish#1', 'stage', { steps: ['describe', 'open'] }),
  {
    type: 'step:start',
    key: DESCRIBE,
    stage: 'publish',
    step: 'describe',
    index: 1,
    of: 2,
    kind: 'agent',
    try: 1,
    model: 'claude-sonnet-5',
  },
  { type: 'agent:thinking', key: DESCRIBE, text: 'Summarise the change for a reviewer.' },
  { type: 'tool:start', key: DESCRIBE, callId: 'tool-1', tool: 'Read', input: { path: '01-spec/call-1/spec.md' } },
  { type: 'tool:end', key: DESCRIBE, callId: 'tool-1', status: 'completed', durationMs: 40 },
  { type: 'tool:start', key: DESCRIBE, callId: 'tool-2', tool: 'Bash', input: { command: 'git push origin HEAD' } },
  {
    type: 'permission:denied',
    key: DESCRIBE,
    callId: 'tool-2',
    tool: 'Bash',
    rule: 'commands',
    permissions: { commands: ['git log *', 'git diff *'] },
    reason: DENIED,
  },
  { type: 'tool:end', key: DESCRIBE, callId: 'tool-2', status: 'denied', durationMs: 0 },
  { type: 'tool:start', key: DESCRIBE, callId: 'tool-3', tool: 'Bash', input: { command: 'git log main..' } },
  { type: 'tool:end', key: DESCRIBE, callId: 'tool-3', status: 'failed', durationMs: 12 },
  { type: 'output:validated', key: DESCRIBE },
  {
    type: 'file:validated',
    key: DESCRIBE,
    name: 'pr-body.md',
    ok: true,
    checks: ['hasSections(Summary, Changes, Testing)', 'noPlaceholders'],
  },
  {
    type: 'step:end',
    key: DESCRIBE,
    step: 'describe',
    try: 1,
    outcome: 'done',
    resultPath: '05-publish/call-1/steps/1-describe/result.json',
  },
  { type: 'step:start', key: OPEN, stage: 'publish', step: 'open', index: 2, of: 2, kind: 'script', try: 1 },
  { type: 'script:exit', key: OPEN, code: 0, outcome: 'passed', durationMs: 1900, stdoutBytes: 66 },
  { type: 'output:validated', key: OPEN },
  {
    type: 'step:end',
    key: OPEN,
    step: 'open',
    try: 1,
    outcome: 'passed',
    resultPath: '05-publish/call-1/steps/2-open/result.json',
  },
  stageEnd('publish#1', 'passed', 14_500, '05-publish/call-1/result.json'),
];

/** What the two-step call prints at `verbosity`, from a runs directory that holds no file of it. */
const twoStep = (verbosity: Verbosity): string[] =>
  render(stream(TWO_STEP_CALL), verbosity, { runsDir: runsWith({}) })
    .trimEnd()
    .split('\n');

const TITLE = 'sail · ticket-to-pr v1 · RUN-1';
const w18 = 18;

test('at normal, a multi-step call prints its start with its step count, each step with its place, kind and model, a validated file by its verdict, and each end; at quiet it prints none of it', () => {
  expect(twoStep('normal')).toEqual([
    TITLE,
    head('publish#1', '▶ publish · 2 steps', w18),
    head(DESCRIBE, '▶ describe · step 1/2 · agent · claude-sonnet-5', w18),
    detail(DESCRIBE, 'output valid', w18),
    detail(DESCRIBE, 'file pr-body.md valid', w18),
    head(DESCRIBE, '✓ done', w18),
    head(OPEN, '▶ open · step 2/2 · script', w18),
    detail(OPEN, 'exit 0 → passed · 1.9s', w18),
    detail(OPEN, 'output valid', w18),
    head(OPEN, '✓ passed', w18),
    head('publish#1', '✓ passed · 14.5s', w18),
  ]);
  expect(twoStep('quiet')).toEqual([TITLE]);
});

test("at verbose, a validated file's verdict is followed by its checks, and a session's thinking, tool calls and denials still print nothing: they are trace's", () => {
  const verbose = twoStep('verbose');
  expect(verbose).toContain(
    detail(DESCRIBE, 'file pr-body.md valid · hasSections(Summary, Changes, Testing), noPlaceholders', w18),
  );
  expect(verbose.filter((line) => /tool:|agent:thinking|permission:denied/.test(line))).toEqual([]);
  // What verbose adds to normal here is that one line's checks.
  expect(verbose.length).toBe(twoStep('normal').length);
});

test('at trace, a session prints its thinking, each tool call from its start to its end, completed, denied or failed, and a denial with the rule and the reason', () => {
  const session = twoStep('trace').filter((line) => /tool:|agent:thinking|permission:denied/.test(line));
  expect(session).toEqual([
    head(DESCRIBE, '· agent:thinking {"text":"Summarise the change for a reviewer."}', w18),
    head(DESCRIBE, '· tool:start {"callId":"tool-1","tool":"Read","input":{"path":"01-spec/call-1/spec.md"}}', w18),
    head(DESCRIBE, '· tool:end {"callId":"tool-1","status":"completed","durationMs":40}', w18),
    head(DESCRIBE, '· tool:start {"callId":"tool-2","tool":"Bash","input":{"command":"git push origin HEAD"}}', w18),
    head(
      DESCRIBE,
      `· permission:denied {"callId":"tool-2","tool":"Bash","rule":"commands","permissions":{"commands":["git log *","git diff *"]},"reason":${JSON.stringify(DENIED)}}`,
      w18,
    ),
    head(DESCRIBE, '· tool:end {"callId":"tool-2","status":"denied","durationMs":0}', w18),
    head(DESCRIBE, '· tool:start {"callId":"tool-3","tool":"Bash","input":{"command":"git log main.."}}', w18),
    head(DESCRIBE, '· tool:end {"callId":"tool-3","status":"failed","durationMs":12}', w18),
  ]);
});

// A group: a header keyed `all`, its calls' lines as they come, then a closing line. Nothing is held back.

const GROUP = ['spec#1', 'implement#1', 'tests#1'];
/** A run of the hand-written roster whose three calls run as one group, interleaved, one of them failing. */
const grouped = (): SailEvent[] =>
  stream([
    rosterStart(),
    { type: 'all:start', keys: GROUP, running: GROUP },
    stageStart('spec#1', 'agent'),
    stageStart('implement#1', 'agent'),
    stageStart('tests#1'),
    stageEnd('implement#1', 'done', 1200, '02-implement/call-1/result.json'),
    stageEnd('spec#1', 'done', 1500, '01-spec/call-1/result.json'),
    stageEnd('tests#1', 'failed', 1800, '03-tests/call-1/result.json'),
    {
      type: 'all:end',
      keys: GROUP,
      outcomes: { 'spec#1': 'done', 'implement#1': 'done', 'tests#1': 'failed' },
      durationMs: 1840,
    },
  ]);

test("at normal, a group prints one header keyed all before its calls' lines and one closing line after them, in event order, and so does trace; quiet prints neither", () => {
  const w = 18;
  const header = head('all', '⇉ 3 at once: spec#1 · implement#1 · tests#1', w);
  const closing = head('all', '⇉ 3 ended · 2 done · 1 failed · 1.8s', w);
  expect(render(grouped(), 'normal')).toBe(
    view(
      'sail · ticket-to-pr v1 · RUN-1',
      header,
      head('spec#1', '▶ spec · agent', w),
      head('implement#1', '▶ implement · agent', w),
      head('tests#1', '▶ tests · script', w),
      head('implement#1', '✓ done · 1.2s', w),
      head('spec#1', '✓ done · 1.5s', w),
      head('tests#1', '✗ failed · 1.8s', w),
      closing,
    ),
  );
  const trace = render(grouped(), 'trace').split('\n');
  expect([trace.indexOf(header), trace.indexOf(closing)]).toEqual([1, trace.length - 2]);
  expect(render(grouped(), 'quiet')).toBe(view('sail · ticket-to-pr v1 · RUN-1'));
});

test('a resumed group says how many of its calls it starts now, and names those', () => {
  const resumed = stream([rosterStart(), { type: 'all:start', keys: GROUP, running: ['tests#1'] }]);
  expect(render(resumed, 'normal').split('\n')[1]).toBe(head('all', '⇉ 1 of 3 at once: tests#1', 18));
});

test("in a terminal, the live line counts a group's running calls, never naming one while two or more run, and goes back to the calls once the group ends", () => {
  const t = inTerminal();
  const events = grouped().slice(1);
  const after = stream([stageStart('describe#1', 'agent')]);
  const seen: (string | undefined)[] = [];
  for (const event of [...events, ...after]) {
    t.terminal.onEvent(event);
    t.advance(1000);
    t.timers.tick();
    seen.push(visibleLive(t.out));
  }
  expect(seen).toEqual([
    'all 0/3 running · 1s',
    'all 1/3 running · 2s',
    'all 2/3 running · 3s',
    'all 3/3 running · 4s',
    'all 2/3 running · 5s',
    'all 1/3 running · 6s',
    'all 0/3 running · 7s',
    undefined,
    'describe#1 running · 1s',
  ]);
});

// biome-ignore format: TDD-PENDING TASK-006
test
  .skip // TDD-PENDING TASK-006
  ("at normal, a step that ends in error prints each of its errors under the step's key, as a call's end does", () => {
  const w = 18;
  const events = stream([
    stageStart('publish#1', 'stage', { steps: ['describe', 'open'] }),
    {
      type: 'step:start',
      key: 'publish#1/describe',
      stage: 'publish',
      step: 'describe',
      index: 1,
      of: 2,
      kind: 'agent',
      try: 1,
    },
    {
      type: 'step:end',
      key: 'publish#1/describe',
      step: 'describe',
      try: 1,
      outcome: 'error',
      resultPath: '05-publish/call-1/steps/1-describe/result.json',
      errors: [
        { reason: 'invalid_output', message: "the output doesn't match its schema:\n→ at title" },
        { reason: 'missing_file', message: "'pr-body.md' was not produced in $STAGE_OUT" },
      ],
    },
  ]);
  expect(render(events, 'normal').trimEnd().split('\n').slice(-4)).toEqual([
    head('publish#1/describe', '✗ error', w),
    detail('publish#1/describe', "invalid_output: the output doesn't match its schema:", w),
    detail('publish#1/describe', '  → at title', w),
    detail('publish#1/describe', "missing_file: 'pr-body.md' was not produced in $STAGE_OUT", w),
  ]);
});

// The terminal consumer: FAKE-1 rendered at each verbosity against its golden view in test/fixtures/terminal/, then
// synthetic events for what FAKE-1 lacks: errors, tails, the final block's rows, the live line, colours and a resume.
import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
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

/** FAKE-1's `run:start` without its envelope: roster keys up to `publish#1/describe`, so an 18-wide key column. */
function fake1Start(): NewEvent {
  const { seq: _seq, ts: _ts, runId: _runId, ...start } = fake1()[0] as SailEvent;
  return start as NewEvent;
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

test.each(['quiet', 'normal'] as const)('FAKE-1 at %s equals its golden view, byte for byte', (verbosity) => {
  expect(render(fake1(), verbosity)).toBe(golden(verbosity));
});

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
      { type: 'error:harness', key: 'spec#1', adapter: 'fake', code: 7 },
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
      fake1Start(),
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
      fake1Start(),
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
    { type: 'step:start', key: 'publish#1/open', stage: 'publish', step: 'open', index: 1, of: 1, kind: 'script' },
    {
      type: 'step:end',
      key: 'publish#1/open',
      step: 'open',
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
  const [start, last] = stream([stageStart('implement#2'), ending ?? { type: 'run:resumed' }]) as [
    SailEvent,
    SailEvent,
  ];
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
    { type: 'step:start', key: 'publish#1/open', stage: 'publish', step: 'open', index: 1, of: 1, kind: 'script' },
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

test.each(['verbose', 'trace'] as const)('FAKE-1 at %s equals its golden view, byte for byte', (verbosity) => {
  expect(render(fake1(), verbosity)).toBe(golden(verbosity));
});

test('at trace, an event of every type prints a line of its own', () => {
  const w = 18;
  const cases: [NewEvent, string][] = [
    [fake1Start(), 'sail · ticket-to-pr v1 · RUN-1'],
    [{ type: 'run:adopted', by: 'watch' }, head('', '· run:adopted {"by":"watch"}', w)],
    [{ type: 'run:resumed' }, head('', '· run:resumed {}', w)],
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
      { type: 'step:start', key: 'publish#1/open', stage: 'publish', step: 'open', index: 2, of: 2, kind: 'script' },
      head('publish#1/open', '▶ open · step 2/2 · script', w),
    ],
    [
      {
        type: 'step:end',
        key: 'publish#1/open',
        step: 'open',
        outcome: 'failed',
        resultPath: '05-publish/call-1/steps/2-open/result.json',
      },
      head('publish#1/open', '✗ failed', w),
    ],
    [{ type: 'loop:iteration', loop: 'fix', iteration: 1, max: 3 }, head('fix', '↻ iteration 1/3', w)],
    [{ type: 'loop:exit', loop: 'fix', iterations: 1, max: 3, reason: 'break' }, head('fix', '↻ break after 1/3', w)],
    [{ type: 'all:start', count: 2 }, head('', '· all:start {"count":2}', w)],
    [{ type: 'all:end' }, head('', '· all:end {}', w)],
    [{ type: 'workflow:route', at: 'tests#1', value: 'passed', took: 'end' }, head('tests#1', '→ end · on passed', w)],
    [{ type: 'journal:append', key: 'tests#1', line: 1, outcome: 'done' }, detail('tests#1', 'journal line 1', w)],
    [{ type: 'agent:message', key: 'spec#1', text: 'hi' }, head('spec#1', '· agent:message {"text":"hi"}', w)],
    [{ type: 'agent:thinking', key: 'spec#1', text: 'hm' }, head('spec#1', '· agent:thinking {"text":"hm"}', w)],
    [
      { type: 'harness:session_start', key: 'spec#1', adapter: 'fake' },
      head('spec#1', '· harness:session_start {"adapter":"fake"}', w),
    ],
    [
      { type: 'harness:session_end', key: 'spec#1', reason: 'submitted' },
      head('spec#1', '· harness:session_end {"reason":"submitted"}', w),
    ],
    [{ type: 'tool:start', key: 'spec#1', tool: 'Read' }, head('spec#1', '· tool:start {"tool":"Read"}', w)],
    [{ type: 'tool:end', key: 'spec#1', status: 'completed' }, head('spec#1', '· tool:end {"status":"completed"}', w)],
    [
      { type: 'permission:denied', key: 'spec#1', tool: 'Bash' },
      head('spec#1', '· permission:denied {"tool":"Bash"}', w),
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
    [{ type: 'usage:update', key: 'spec#1', turn: 1 }, head('spec#1', '· usage:update {"turn":1}', w)],
    [{ type: 'budget:warning', key: 'spec#1', usd: 4 }, head('spec#1', '· budget:warning {"usd":4}', w)],
    [{ type: 'budget:exceeded', key: 'spec#1', usd: 6 }, head('spec#1', '· budget:exceeded {"usd":6}', w)],
    [{ type: 'ticket:fetched', ticketKey: 'FAKE-1' }, head('', '· ticket:fetched {"ticketKey":"FAKE-1"}', w)],
    [{ type: 'ticket:claimed', ticketKey: 'FAKE-1' }, head('', '· ticket:claimed {"ticketKey":"FAKE-1"}', w)],
    [{ type: 'ticket:updated', ticketKey: 'FAKE-1' }, head('', '· ticket:updated {"ticketKey":"FAKE-1"}', w)],
    [{ type: 'ticket:commented', ticketKey: 'FAKE-1' }, head('', '· ticket:commented {"ticketKey":"FAKE-1"}', w)],
    [{ type: 'codehost:pushed', number: 1 }, head('', '· codehost:pushed {"number":1}', w)],
    [{ type: 'codehost:pr_opened', number: 1 }, head('', '· codehost:pr_opened {"number":1}', w)],
    [{ type: 'codehost:checks', number: 1 }, head('', '· codehost:checks {"number":1}', w)],
    [{ type: 'codehost:labelled', number: 1 }, head('', '· codehost:labelled {"number":1}', w)],
    [{ type: 'codehost:commented', number: 1 }, head('', '· codehost:commented {"number":1}', w)],
    [{ type: 'codehost:merged', number: 1 }, head('', '· codehost:merged {"number":1}', w)],
    [{ type: 'workspace:leased', branch: 'sail/FAKE-1' }, head('', '· workspace:leased {"branch":"sail/FAKE-1"}', w)],
    [
      { type: 'workspace:lease_released', branch: 'sail/FAKE-1' },
      head('', '· workspace:lease_released {"branch":"sail/FAKE-1"}', w),
    ],
    [{ type: 'workspace:created', branch: 'sail/FAKE-1' }, head('', '· workspace:created {"branch":"sail/FAKE-1"}', w)],
    [
      { type: 'workspace:released', branch: 'sail/FAKE-1' },
      head('', '· workspace:released {"branch":"sail/FAKE-1"}', w),
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
    [{ type: 'run:end', status: 'completed', replays: 1 }, '  replays  1'],
    [{ type: 'error:crash', message: 'boom' }, head('', '✗ crash: boom', w)],
  ];
  expect(cases.map(([event]) => event.type).sort()).toEqual([...EVENT_TYPES].sort());

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
    prior: events.filter((event) => event.seq <= 55),
  });
  expect(out).toBe('');

  for (const event of events.filter((each) => each.seq > 55)) terminal.onEvent(event);
  const normal = golden('normal').split('\n');
  const resumedAt = normal.findIndex((line) => line.endsWith('↻ iteration 2/3 · feedback from tests#1'));
  expect(resumedAt).toBe(24);
  expect(out).toBe(
    [
      `sail · ticket-to-pr v1 · ${FAKE_1} · resumed after 4 calls, last tests#1 failed`,
      ...normal.slice(resumedAt),
    ].join('\n'),
  );
});

test('the final block adds up the replays of every run:end, earlier ones included', () => {
  const events = stream([
    fake1Start(),
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

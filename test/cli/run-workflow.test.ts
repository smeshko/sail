// `sail <ticket>`, in process through run(): a run of the stub repository from one of its tickets, from the type-check
// and the ticket's checks to the exit code, with `--force`, `--until`, and Ctrl-C through a fake `io.onInterrupt`. Each
// case has a temp repository of its own, because a process opens one run per .sail/, and a refusal claims it too. So a
// second command on the same ticket runs in a copy of the first one's repository.
import { expect, test } from 'bun:test';
import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { basename, join } from 'node:path';
import { verbosityOf } from '../../src/cli/commands/run-workflow';
import { EXIT_FAILED, EXIT_INTERNAL, EXIT_OK, EXIT_REFUSED, EXIT_SUSPENDED } from '../../src/cli/exit-codes';
import type { Parsed } from '../../src/cli/index';
import { readJournal } from '../../src/engine/journal';
import { type Forced, readStatus } from '../../src/engine/run-dir';
import type { RunHeader } from '../../src/engine/run-header';
import { formatIssue, validateRunDir } from '../../src/engine/schemas';
import { readEvents } from '../../src/events/consumers/ndjson';
import { rebuildSummary } from '../../src/events/consumers/summary';
import type { Summary } from '../../src/events/summary';
import type { TicketState } from '../../src/ports/types';
import { fakeAdapters } from '../helpers/adapters';
import {
  entryOf,
  journaled,
  NO_SUMMARY,
  NO_SUMMARY_MESSAGE,
  NO_TASKS,
  NO_TASKS_MESSAGE,
  RUN_ARGV,
  runDirIn,
  SPEC,
  sessions,
  specDir,
  specFile,
  submits,
  usageOf,
  writeAgentFixture,
} from '../helpers/agent-fixture';
import { copyFixture, edit, FIXTURE_SAIL, write } from '../helpers/fixture';
import {
  type Captured,
  type CaptureOptions,
  fakeInterrupts,
  normaliseDurations,
  runCaptured,
} from '../helpers/run-captured';
import {
  copyRun,
  interruptWhenAsleep,
  type StubOptions,
  stubExecutions,
  writePrOnly,
  writeStub,
} from '../helpers/stub-workflow';
import { withTempRepo } from '../helpers/temp-repo';

const WORKFLOW = 'workflows/ticket-to-pr/workflow.ts';
const IN_PROGRESS: TicketState = { type: 'started', name: 'In Progress' };

/** The runs in the repository's `.sail-runs/`: every entry but `fake/`, where the fake adapters keep their state. */
const runIds = (repoDir: string): string[] =>
  existsSync(join(repoDir, '.sail-runs'))
    ? readdirSync(join(repoDir, '.sail-runs'))
        .filter((name) => name !== 'fake')
        .sort()
    : [];

/**
 * `sail <argv>` in a fresh stub repository changed by `change`, with the ids of the runs it left. `touched` says
 * whether anything was written under `.sail-runs/`: a run directory, or the fake's record of a ticket that moved.
 */
async function sailIn(
  argv: string[],
  options: StubOptions = {},
  change: (sail: string) => void = () => undefined,
  capture: CaptureOptions = {},
): Promise<Captured & { lines: string[]; runs: string[]; view: string; touched: boolean }> {
  return withTempRepo(async (repo) => {
    change(writeStub(repo.dir, options));
    const captured = await runCaptured(argv, repo.dir, capture);
    const runs = runIds(repo.dir);
    const view = normaliseDurations(captured.stdout);
    const touched = existsSync(join(repo.dir, '.sail-runs'));
    return { ...captured, lines: captured.stdout.trimEnd().split('\n'), runs, view, touched };
  });
}

/** What `sail <argv>` left in `repoDir`: what it printed, its newest run's header and events, and a ticket as it is now. */
async function started(repoDir: string, argv: string[], ticketKey = 'FAKE-1') {
  const captured = await runCaptured(argv, repoDir);
  const runs = runIds(repoDir);
  const runId = runs.at(-1) ?? '';
  const dir = join(repoDir, '.sail-runs', runId);
  const ran = captured.code !== EXIT_REFUSED && runId !== '';
  const header: Partial<RunHeader> = ran ? JSON.parse(readFileSync(join(dir, 'run.json'), 'utf8')) : {};
  const ticket = await (await fakeAdapters(repoDir)).ports.ticketSource.get(ticketKey);
  return { ...captured, runs, runId, dir, header, events: ran ? readEvents(dir) : [], ticket };
}

/** A head line and a detail line of the stub's terminal view: its key column is 13 wide, for `self-review#1`. */
const head = (key: string, text: string) => `${key.padEnd(13)}  ${text}`;
const detail = (key: string, text: string) => `${key.padEnd(13)}    ${text}`;

// biome-ignore format: TDD-PENDING TASK-007
test
  .skip // TDD-PENDING TASK-007
  ('sail FAKE-1 prints the run as the terminal view: the intake, each call, its exit, its output, the loop, a failure tail and the final block', async () => {
  const { code, view, stderr, runs } = await sailIn(['FAKE-1']);
  expect({ code, stderr }).toEqual({ code: EXIT_OK, stderr: '' });
  expect(runs).toHaveLength(1);
  const [runId] = runs;
  expect(runId).toMatch(/^FAKE-1-[0-9A-Z]{26}$/);
  expect(view).toBe(
    [
      `sail · ticket-to-pr v1 · ${runId}`,
      'intake#1       ▶ intake ticket · builtin',
      'intake#1         output valid',
      'intake#1       ✓ passed',
      'spec#1         ▶ spec · script',
      'spec#1           exit 0 → passed · <t>',
      'spec#1           output valid',
      'spec#1         ✓ passed · <t>',
      'fix            ↻ iteration 1/3',
      'implement#1    ▶ implement · script',
      'implement#1      exit 0 → passed · <t>',
      'implement#1      output valid',
      'implement#1    ✓ passed · <t>',
      'tests#1        ▶ tests · script',
      'tests#1          exit 1 → failed · <t>',
      'tests#1          output valid',
      'tests#1        ✗ failed · <t>',
      'tests#1          stdout.log',
      'tests#1          │ {"ok":false,"total":1,"failed":1,"durationMs":0,"failures":[{"test":"greets","file":"test/greet.test.ts","message":"expected a greeting"}]}',
      'fix            ↻ iteration 2/3 · feedback from tests#1',
      'implement#2    ▶ implement · script',
      'implement#2      exit 0 → passed · <t>',
      'implement#2      output valid',
      'implement#2    ✓ passed · <t>',
      'tests#2        ▶ tests · script',
      'tests#2          exit 0 → passed · <t>',
      'tests#2          output valid',
      'tests#2        ✓ passed · <t>',
      'self-review#1  ▶ self-review · script',
      'self-review#1    exit 0 → passed · <t>',
      'self-review#1    output valid',
      'self-review#1  ✓ passed · <t>',
      'fix            ↻ break after 2/3',
      'publish#1      ▶ publish · script',
      'publish#1        exit 0 → passed · <t>',
      'publish#1        output valid',
      'publish#1      ✓ passed · <t>',
      '',
      'completed · <t>',
      '  calls    8 · 7 passed, 1 failed',
      '  loops    fix 2/3',
      '  replays  8',
      `  run      .sail-runs/${runId}`,
      '',
    ].join('\n'),
  );
});

// biome-ignore format: TDD-PENDING TASK-007
test
  .skip // TDD-PENDING TASK-007
  ('a run whose tests never pass exits 1, its final block naming the stop reason and why', async () => {
  const { code, view, runs } = await sailIn(['FAKE-1', '--workflow', 'ticket-to-pr'], { testsPassAt: 99 });
  expect(code).toBe(EXIT_FAILED);
  const [runId] = runs;
  expect(view).toEndWith(
    [
      '',
      'failed · <t>',
      '  stop     workflow_failed: loop "fix" exceeded 3',
      '  calls    8 · 5 passed, 3 failed',
      '  loops    fix 3/3',
      '  replays  8',
      `  run      .sail-runs/${runId}`,
      '',
    ].join('\n'),
  );
});

// biome-ignore format: TDD-PENDING TASK-007
test
  .skip // TDD-PENDING TASK-007
  ('sail FAKE-1 -q prints the header, a call that ends in error with its message, and the final block, and exits 1', async () => {
  const { code, view, runs } = await sailIn(['FAKE-1', '-q'], {}, (sail) =>
    edit(sail, 'stages/tests/run.sh', 'pass_at=2\n', 'exit 2\n'),
  );
  expect(code).toBe(EXIT_FAILED);
  const [runId] = runs;
  expect(view).toBe(
    [
      `sail · ticket-to-pr v1 · ${runId}`,
      'tests#1        ✗ error · <t>',
      'tests#1          exit_code: exit code 2 is not mapped to passed or failed',
      '',
      'failed · <t>',
      '  stop     stage_error: tests#1 ended in error: exit_code: exit code 2 is not mapped to passed or failed',
      '  calls    4 · 3 passed, 1 error',
      '  loops    fix 1/3',
      '  replays  4',
      `  run      .sail-runs/${runId}`,
      '',
    ].join('\n'),
  );
});

// biome-ignore format: TDD-PENDING TASK-007
test
  .skip // TDD-PENDING TASK-007
  ("sail FAKE-1 -v adds each command and the tail of every script, and -vv adds each journal line and the claim's two events", async () => {
  const verbose = await sailIn(['FAKE-1', '-v']);
  expect(verbose.code).toBe(EXIT_OK);
  const specTail = [
    detail('spec#1', 'stdout.log'),
    detail('spec#1', '│ {"summary":"Add a greeting.","tasks":[{"title":"Add greet()","files":["src/greet.ts"]}]}'),
  ].join('\n');
  expect(verbose.view).toContain(`\n${detail('tests#1', '$ .sail/stages/tests/run.sh')}\n`);
  expect(verbose.view).toContain(`\n${specTail}\n`);
  expect(verbose.view).not.toContain('journal line');
  expect(verbose.view).not.toContain('ticket:claimed');

  const trace = await sailIn(['FAKE-1', '-vv']);
  expect(trace.view).toContain(`\n${specTail}\n`);
  expect(trace.view).toContain(`\n${detail('intake#1', 'journal line 1')}\n${head('spec#1', '▶ spec · script')}\n`);
  expect(trace.view).toContain(`\n${detail('spec#1', 'journal line 2')}\n`);
  // The claim belongs to no call: its two events print as generic lines with no key, right under the header.
  const [traced] = trace.runs;
  expect(trace.view.split('\n').slice(1, 4)).toEqual([
    `${' '.repeat(15)}· ticket:claimed {"ticketKey":"FAKE-1","state":{"type":"started","name":"In Progress"}}`,
    `${' '.repeat(15)}· ticket:commented {"ticketKey":"FAKE-1","body":"sail run ${traced} started"}`,
    head('intake#1', '▶ intake ticket · builtin'),
  ]);
});

test('verbosityOf maps no flag, -q, -v, -vv and -vvv to normal, quiet, verbose, trace and trace', () => {
  const io = { cwd: '.', stdout: () => undefined, stderr: () => undefined };
  const of = (values: Parsed['values']) => verbosityOf({ values, positionals: ['FAKE-1'] }, io, 'sail FAKE-1');
  expect([{}, { quiet: true }, { verbose: 1 }, { verbose: 2 }, { verbose: 3 }].map(of)).toEqual([
    'normal',
    'quiet',
    'verbose',
    'trace',
    'trace',
  ]);
});

// biome-ignore format: TDD-PENDING TASK-007
test
  .skip // TDD-PENDING TASK-007
  ('sail FAKE-1 refuses -q with -v, and sail check takes no -v, each with exit 3 before anything runs', async () => {
  const { code, stdout, stderr, touched } = await sailIn(['FAKE-1', '-q', '-v']);
  expect({ code, stdout, stderr, touched }).toEqual({
    code: EXIT_REFUSED,
    stdout: '',
    stderr: "sail FAKE-1: -q and -v can't be combined\n",
    touched: false,
  });
  expect(await runCaptured(['check', '-v'])).toEqual({
    code: EXIT_REFUSED,
    stdout: '',
    stderr: "sail: unknown argument '-v'\nRun 'sail --help' for usage.\n",
  });
});

// biome-ignore format: TDD-PENDING TASK-007
test
  .skip // TDD-PENDING TASK-007
  ('in a terminal, sail FAKE-1 colours its lines and draws the live line, then ends with the final block', async () => {
  const { code, stdout, runs } = await sailIn(['FAKE-1'], {}, () => undefined, { tty: { columns: () => 120 } });
  expect(code).toBe(EXIT_OK);
  const [runId] = runs;
  expect({
    coloured: stdout.includes('\x1b['),
    live: stdout.includes(' running · '),
    blockAfterLastClear: stdout.lastIndexOf('\r\x1b[2K') < stdout.lastIndexOf('completed'),
    endsWithBlock: stdout.endsWith(`  run      .sail-runs/${runId}\n`),
  }).toEqual({ coloured: true, live: true, blockAfterLastClear: true, endsWithBlock: true });
});

const TYPE_ERROR = "{ spec: s.files['spec.md'], feedback: iteration.previous }";

// biome-ignore format: TDD-PENDING TASK-007
test
  .skip // TDD-PENDING TASK-007
  .each<[string, string[], (sail: string) => void, string]>([
  [
    'an unknown workflow',
    ['FAKE-1', '--workflow', 'nope'],
    () => undefined,
    "sail FAKE-1: no workflow 'nope': .sail/workflows/nope/workflow.ts doesn't exist\n",
  ],
  [
    'a name that is not a workflow name',
    ['FAKE-1', '--workflow', '../stages'],
    () => undefined,
    "sail FAKE-1: '../stages' is not a workflow name: lowercase letters, digits and dashes\n",
  ],
  [
    'no --workflow, and no defaultWorkflow',
    ['FAKE-1'],
    (sail) => edit(sail, 'project.yaml', 'defaultWorkflow: ticket-to-pr\n', ''),
    'sail FAKE-1: no --workflow given, and .sail/project.yaml sets no defaultWorkflow\n',
  ],
  [
    'an argument the ticket source does not parse',
    ['FAKE1'],
    () => undefined,
    "sail FAKE1: 'FAKE1' is not a ticket of the fake ticket source: a ticket key, or a URL it owns\n",
  ],
  [
    'a mistyped command, which reads as a ticket',
    ['chekc'],
    () => undefined,
    "sail chekc: 'chekc' is not a ticket of the fake ticket source: a ticket key, or a URL it owns\n",
  ],
  [
    'a ticket the ticket source does not have',
    ['FAKE-9'],
    () => undefined,
    'sail FAKE-9: ticketSource.get: no ticket FAKE-9 (not_found)\n',
  ],
  [
    'a ticket without the label',
    ['FAKE-3'],
    () => undefined,
    "sail FAKE-3: the ticket is not designated: it carries no 'sail' label. --force runs it anyway\n",
  ],
  [
    'a ticket that is In Progress',
    ['FAKE-4'],
    () => undefined,
    'sail FAKE-4: the ticket is already claimed: it is In Progress. --force runs it anyway\n',
  ],
  [
    'a workflow whose intake accepts only pull requests',
    ['FAKE-1', '--workflow', 'pr-only'],
    writePrOnly,
    "sail FAKE-1: .sail/workflows/pr-only/workflow.ts: its intake 'pull-request' accepts pr, and FAKE-1 is a ticket\n",
  ],
  [
    '--until naming no stage of the workflow',
    ['FAKE-1', '--until', 'nope'],
    () => undefined,
    "sail FAKE-1: --until names 'nope', which is no stage of workflow 'ticket-to-pr': its stages are implement, publish, self-review, spec, tests\n",
  ],
])(
  '%s is refused with exit 3 in one line, with no run directory and the ticket never written to',
  async (_, argv, change, refusal) => {
    const { code, stdout, stderr, touched } = await sailIn(argv, {}, change);
    expect({ code, stdout, stderr, touched }).toEqual({
      code: EXIT_REFUSED,
      stdout: '',
      stderr: refusal,
      touched: false,
    });
  },
);

// biome-ignore format: TDD-PENDING TASK-007
test
  .skip // TDD-PENDING TASK-007
  ('a type error in the workflow is printed where it is, then refused with exit 3 and no run directory: the ticket is not looked at, so one that is not designated changes nothing', async () => {
  const breakIt = (sail: string) => edit(sail, WORKFLOW, TYPE_ERROR, '{}');
  for (const ticket of ['FAKE-1', 'FAKE-3']) {
    const { code, stdout, stderr, touched } = await sailIn([ticket], {}, breakIt);
    const [diagnostic, refusal, ...rest] = stderr.split('\n');
    expect(diagnostic).toMatch(/^\.sail\/workflows\/ticket-to-pr\/workflow\.ts:\d+:\d+ {2}TS2741 {2}/);
    expect({ code, stdout, refusal, rest, touched }).toEqual({
      code: EXIT_REFUSED,
      stdout: '',
      refusal: `sail ${ticket}: 1 type error in .sail/workflows/ticket-to-pr/workflow.ts`,
      rest: [''],
      touched: false,
    });
  }
});

// The ticket: claimed as the run starts, forced past its checks, and stopped by --until.

// biome-ignore format: TDD-PENDING TASK-007
test
  .skip // TDD-PENDING TASK-007
  ('sail FAKE-1 claims the ticket for its one run: run.json records nothing forced and the claim, the stream reports it, and the ticket is In Progress with a comment naming the run', async () => {
  await withTempRepo(async (repo) => {
    writeStub(repo.dir, { testsPassAt: 1 });
    const { code, stderr, runs, runId, header, events, ticket } = await started(repo.dir, ['FAKE-1']);
    expect({ code, stderr, runs: runs.length }).toEqual({ code: EXIT_OK, stderr: '', runs: 1 });
    expect([header.source, header.claim]).toEqual([
      { kind: 'ticket', ticketKey: 'FAKE-1', via: 'cli', forced: [] },
      { claimed: true, state: IN_PROGRESS },
    ]);
    expect(events.slice(0, 4).map((event) => event.type)).toEqual([
      'run:start',
      'ticket:claimed',
      'ticket:commented',
      'intake:start',
    ]);
    expect([ticket.state, ticket.comments.at(-1)?.body]).toEqual([IN_PROGRESS, `sail run ${runId} started`]);
  });
});

// biome-ignore format: TDD-PENDING TASK-007
test
  .skip // TDD-PENDING TASK-007
  ('sail given a URL the ticket source owns starts the run of the ticket it names, and a refusal would name the URL as typed', async () => {
  await withTempRepo(async (repo) => {
    writeStub(repo.dir, { testsPassAt: 1 });
    const { code, stderr, runId, header } = await started(repo.dir, ['fake://tickets/FAKE-1']);
    expect({ code, stderr }).toEqual({ code: EXIT_OK, stderr: '' });
    expect([runId.slice(0, 7), header.source?.ticketKey]).toEqual(['FAKE-1-', 'FAKE-1']);
  });
  const refused = await sailIn(['fake://tickets/FAKE-3']);
  expect(refused.stderr).toStartWith('sail fake://tickets/FAKE-3: the ticket is not designated: ');
});

// biome-ignore format: TDD-PENDING TASK-007
test
  .skip // TDD-PENDING TASK-007
  .each<[string, string, Forced[]]>([
  ['FAKE-3, which carries no label', 'FAKE-3', ['designation']],
  ['FAKE-5, which carries no label and is Done', 'FAKE-5', ['designation', 'state']],
])('sail --force runs %s, and run.json lists what it overrode', async (_, ticketKey, forced) => {
  await withTempRepo(async (repo) => {
    writeStub(repo.dir, { testsPassAt: 1 });
    const { code, stderr, header, ticket } = await started(repo.dir, [ticketKey, '--force'], ticketKey);
    expect({ code, stderr }).toEqual({ code: EXIT_OK, stderr: '' });
    expect(header.source).toEqual({ kind: 'ticket', ticketKey, via: 'cli', forced });
    expect([header.claim?.claimed, ticket.state]).toEqual([forced.length === 1, IN_PROGRESS]);
  });
});

/** A repository holding the stub and one completed run of `FAKE-1`, copied into `to` so a second command can run there. */
function afterFirstRun(to: string): Promise<string> {
  return withTempRepo(async (from) => {
    writeStub(from.dir, { testsPassAt: 1 });
    const first = await started(from.dir, ['FAKE-1']);
    expect(first.code).toBe(EXIT_OK);
    copyRun(from.dir, to);
    return first.runId;
  });
}

// biome-ignore format: TDD-PENDING TASK-007
test
  .skip // TDD-PENDING TASK-007
  ('a second sail FAKE-1 is refused with exit 3 as already claimed, and adds no run directory', async () => {
  await withTempRepo(async (repo) => {
    const first = await afterFirstRun(repo.dir);
    const second = await started(repo.dir, ['FAKE-1']);
    expect({ code: second.code, stdout: second.stdout, stderr: second.stderr, runs: second.runs }).toEqual({
      code: EXIT_REFUSED,
      stdout: '',
      stderr: 'sail FAKE-1: the ticket is already claimed: it is In Progress. --force runs it anyway\n',
      runs: [first],
    });
    expect(second.ticket.comments.map((comment) => comment.body).slice(1)).toEqual([`sail run ${first} started`]);
  });
});

// biome-ignore format: TDD-PENDING TASK-007
test
  .skip // TDD-PENDING TASK-007
  ('a second sail FAKE-1 --force runs: it moves the ticket through update, records the state check as overridden and the claim as not taken, and comments again', async () => {
  await withTempRepo(async (repo) => {
    const first = await afterFirstRun(repo.dir);
    const second = await started(repo.dir, ['FAKE-1', '--force']);
    expect({ code: second.code, stderr: second.stderr, runs: second.runs.length }).toEqual({
      code: EXIT_OK,
      stderr: '',
      runs: 2,
    });
    expect([second.header.source?.forced, second.header.claim]).toEqual([
      ['state'],
      { claimed: false, state: IN_PROGRESS },
    ]);
    expect(second.events.slice(1, 3).map((event) => event.type)).toEqual(['ticket:updated', 'ticket:commented']);
    expect(second.ticket.comments.map((comment) => comment.body).slice(1)).toEqual([
      `sail run ${first} started`,
      `sail run ${second.runId} started`,
    ]);
  });
});

// biome-ignore format: TDD-PENDING TASK-007
test
  .skip // TDD-PENDING TASK-007
  ('sail FAKE-1 --until spec stops after spec#1 with exit 2: the final block names until, the last line says how to resume, and sail resume then runs the rest and exits 0', async () => {
  await withTempRepo(async (repo) => {
    const stopped = await withTempRepo(async (from) => {
      writeStub(from.dir, { testsPassAt: 1 });
      const captured = await runCaptured(['FAKE-1', '--until', 'spec'], from.dir);
      const [runId = ''] = runIds(from.dir);
      const dir = join(from.dir, '.sail-runs', runId);
      const left =
        captured.code === EXIT_SUSPENDED
          ? {
              status: readFileSync(join(dir, 'STATUS'), 'utf8'),
              keys: readJournal(dir).entries.map((entry) => entry.key),
            }
          : undefined;
      copyRun(from.dir, repo.dir);
      return { ...captured, runId, left };
    });
    expect({ code: stopped.code, stderr: stopped.stderr }).toEqual({ code: EXIT_SUSPENDED, stderr: '' });
    expect(normaliseDurations(stopped.stdout)).toEndWith(
      [
        '',
        'suspended · <t>',
        '  stop     until: stopped after spec#1, as --until asked',
        '  calls    2 · 2 passed',
        '  loops    fix 1/3',
        '  replays  2',
        `  run      .sail-runs/${stopped.runId}`,
        `resume it with: sail resume ${stopped.runId}`,
        '',
      ].join('\n'),
    );
    expect(stopped.left).toEqual({ status: 'suspended until\n', keys: ['intake#1', 'spec#1'] });

    const resumed = await runCaptured(['resume', stopped.runId], repo.dir);
    expect({ code: resumed.code, stderr: resumed.stderr }).toEqual({ code: EXIT_OK, stderr: '' });
    const dir = join(repo.dir, '.sail-runs', stopped.runId);
    expect(readJournal(dir).entries.map((entry) => entry.key)).toEqual([
      'intake#1',
      'spec#1',
      'implement#1',
      'tests#1',
      'self-review#1',
      'publish#1',
    ]);
    expect(stubExecutions(repo.dir)).toEqual(['spec#1', 'implement#1', 'tests#1', 'self-review#1', 'publish#1']);
    expect(validateRunDir(dir).issues.map(formatIssue)).toEqual([]);
  });
});

// What is gone: `sail run` and `--input`. A run starts from a ticket and from nothing else.

// biome-ignore format: TDD-PENDING TASK-011
test
  .skip // TDD-PENDING TASK-011
  ('sail run starts nothing: run reads as a ticket the ticket source does not know, and is refused with exit 3', async () => {
  const { code, stdout, stderr, touched } = await sailIn(['run']);
  expect({ code, stdout, stderr, touched }).toEqual({
    code: EXIT_REFUSED,
    stdout: '',
    stderr: "sail run: 'run' is not a ticket of the fake ticket source: a ticket key, or a URL it owns\n",
    touched: false,
  });
});

// biome-ignore format: TDD-PENDING TASK-011
test
  .skip // TDD-PENDING TASK-011
  ('sail FAKE-1 --input is refused as an unknown argument with exit 3, and nothing starts', async () => {
  const { code, stdout, stderr, touched } = await sailIn(['FAKE-1', '--input', '{}']);
  expect({ code, stdout, stderr, touched }).toEqual({
    code: EXIT_REFUSED,
    stdout: '',
    stderr: "sail: unknown argument '--input'\nRun 'sail --help' for usage.\n",
    touched: false,
  });
});

// biome-ignore format: TDD-PENDING TASK-007
test
  .skip // TDD-PENDING TASK-007
  ('a project.yaml that breaks its schema is refused with its issues', async () => {
  const { code, stderr, touched } = await sailIn(['FAKE-1'], {}, (sail) =>
    edit(sail, 'project.yaml', 'adapters:\n', 'no-adapters:\n'),
  );
  expect(stderr).toContain('.sail/project.yaml  [sail.project.v1]  /adapters is required');
  expect({ code, touched }).toEqual({ code: EXIT_REFUSED, touched: false });
});

// biome-ignore format: TDD-PENDING TASK-007
test
  .skip // TDD-PENDING TASK-007
  ('outside a git repository, sail FAKE-1 is refused', async () => {
  await withTempRepo(async (repo) => {
    const { code, stderr } = await runCaptured(['FAKE-1'], repo.home);
    expect(stderr).toBe(`sail FAKE-1: not inside a git repository: ${repo.home}\n`);
    expect(code).toBe(EXIT_REFUSED);
  });
});

// biome-ignore format: TDD-PENDING TASK-007
test
  .skip // TDD-PENDING TASK-007
  ('a journal corrupted mid-run is an internal error, exit 4', async () => {
  const { code, stderr } = await sailIn(['FAKE-1'], {}, (sail) =>
    edit(
      sail,
      'workflows/ticket-to-pr/stages/spec/run.sh',
      "printf '# Spec",
      'echo not-json >>"$STAGE_OUT/../../journal.ndjson"\nprintf \'# Spec',
    ),
  );
  expect(stderr).toStartWith('sail: internal error: ');
  expect(stderr).toContain('journal.ndjson:2 is not valid JSON');
  expect(code).toBe(EXIT_INTERNAL);
});

/** `sail <argv>` of the stub in `repoDir`, interrupted through `io.onInterrupt` once `implement#2` sleeps. */
async function interruptedRun(repoDir: string, argv: string[]) {
  writeStub(repoDir, { sleepAt: 'implement#2' });
  const interrupts = fakeInterrupts();
  const { end, alive } = await interruptWhenAsleep(
    repoDir,
    runCaptured(argv, repoDir, interrupts),
    interrupts.interrupt,
  );
  const [runId = ''] = runIds(repoDir);
  return { ...end, lines: end.stdout.trimEnd().split('\n'), runId, alive, interrupts };
}

// biome-ignore format: TDD-PENDING TASK-007
test
  .skip // TDD-PENDING TASK-007
  ('Ctrl-C during sail FAKE-1 ends the running call in error, suspends the run, prints how to resume it, and exits 2', async () => {
  await withTempRepo(async (repo) => {
    const { code, stdout, stderr, runId, alive, interrupts } = await interruptedRun(repo.dir, ['FAKE-1']);
    expect({ code, stderr }).toEqual({ code: EXIT_SUSPENDED, stderr: '' });
    const view = normaliseDurations(stdout);
    expect(view).toContain(
      `\n${head('implement#2', '✗ error · <t>')}\n${detail('implement#2', 'exit_code: interrupted, then ended by signal SIGTERM')}\n`,
    );
    expect(view).toEndWith(
      [
        '',
        'suspended · <t>',
        '  stop     interrupted: stopped during implement#2',
        '  calls    4 · 3 passed, 1 failed',
        '  loops    fix 2/3',
        '  replays  4',
        `  run      .sail-runs/${runId}`,
        `resume it with: sail resume ${runId}`,
        '',
      ].join('\n'),
    );
    expect(alive).toEqual([]);
    expect([interrupts.registered, interrupts.unregistered]).toEqual([1, 1]);
  });
}, 20_000);

// biome-ignore format: TDD-PENDING TASK-007
test
  .skip // TDD-PENDING TASK-007
  ('the interrupt handler is unregistered even when the run throws', async () => {
  await withTempRepo(async (repo) => {
    const sail = writeStub(repo.dir);
    edit(
      sail,
      'workflows/ticket-to-pr/stages/spec/run.sh',
      "printf '# Spec",
      'echo not-json >>"$STAGE_OUT/../../journal.ndjson"\nprintf \'# Spec',
    );
    const interrupts = fakeInterrupts();
    const { code } = await runCaptured(['FAKE-1'], repo.dir, interrupts);
    expect(code).toBe(EXIT_INTERNAL);
    expect([interrupts.registered, interrupts.unregistered]).toEqual([1, 1]);
  });
});

const TOKEN = 'echo-token-9c1f7d2a';
const ECHO_HARNESS = { use: './adapters/echo-harness.ts' };
const ECHO_ORIGIN = 'repo:.sail/adapters/echo-harness.ts';

/** Gives the stub the fixture's echo harness, and names it for the harness port. */
function useEcho(sail: string): void {
  write(sail, 'adapters/echo-harness.ts', readFileSync(join(FIXTURE_SAIL, 'adapters', 'echo-harness.ts'), 'utf8'));
  edit(sail, 'project.yaml', 'harness: { use: fake }', `harness: { use: ${ECHO_HARNESS.use} }`);
}

/** `sail FAKE-1` in a stub repository changed by `change`, with `env` as the command's environment. */
async function runWith(change: (sail: string) => void, env?: Record<string, string>) {
  return withTempRepo(async (repo) => {
    change(writeStub(repo.dir));
    const captured = await runCaptured(['FAKE-1'], repo.dir, env === undefined ? {} : { env });
    const runs = join(repo.dir, '.sail-runs');
    const [runId] = runIds(repo.dir);
    const read = (file: string) => (runId === undefined ? '' : readFileSync(join(runs, runId, file), 'utf8'));
    const files = runId === undefined ? [] : [...new Bun.Glob('**/*').scanSync({ cwd: runs, dot: true })];
    return {
      ...captured,
      ranFrom: existsSync(runs),
      header: runId === undefined ? undefined : (JSON.parse(read('run.json')) as RunHeader),
      started: runId === undefined ? undefined : (JSON.parse(read('events.ndjson').split('\n')[0] ?? '') as RunHeader),
      everything: files.map((file) => readFileSync(join(runs, file), 'utf8')).join('\n'),
    };
  });
}

// biome-ignore format: TDD-PENDING TASK-007
test
  .skip // TDD-PENDING TASK-007
  ("run.json and run:start record each adapter: four builtin fakes, then the repository's own harness with its origin and versions, and the token stays off disk", async () => {
  const fake = { use: 'fake', origin: 'builtin' };
  const plain = await runWith(() => undefined);
  expect(plain.code).toBe(EXIT_OK);
  expect(plain.header?.adapters).toEqual({ ticketSource: fake, codeHost: fake, harness: fake, workspace: fake });

  const echo = { use: ECHO_HARNESS.use, origin: ECHO_ORIGIN, versions: { echo: '1.0.0' } };
  const swapped = await runWith(useEcho, { ECHO_HARNESS_TOKEN: TOKEN });
  expect(swapped.code).toBe(EXIT_OK);
  expect(swapped.header?.adapters).toEqual({ ticketSource: fake, codeHost: fake, harness: echo, workspace: fake });
  expect(swapped.started?.adapters).toEqual(swapped.header?.adapters);
  expect(swapped.everything).not.toBe('');
  expect(swapped.everything).not.toContain(TOKEN);
});

// biome-ignore format: TDD-PENDING TASK-007
test
  .skip // TDD-PENDING TASK-007
  .each<[string, Record<string, string>]>([
  ['unset', {}],
  ['empty', { ECHO_HARNESS_TOKEN: '' }],
])(
  'a harness whose token is %s is refused with exit 3, naming the variable and the port, and no run directory',
  async (_, env) => {
    const { code, stdout, stderr, ranFrom } = await runWith(useEcho, env);
    expect({ code, stdout, stderr, ranFrom }).toEqual({
      code: EXIT_REFUSED,
      stdout: '',
      stderr: '.sail/project.yaml  /adapters/harness needs ECHO_HARNESS_TOKEN, which is not set\n',
      ranFrom: false,
    });
  },
);

// biome-ignore format: TDD-PENDING TASK-007
test
  .skip // TDD-PENDING TASK-007
  ('an adapter the built-ins do not have is refused with exit 3, naming the port, and no run directory', async () => {
  const { code, stderr, ranFrom } = await runWith((sail) =>
    edit(sail, 'project.yaml', 'codeHost: { use: fake }', 'codeHost: { use: githb }'),
  );
  expect({ code, stderr, ranFrom }).toEqual({
    code: EXIT_REFUSED,
    stderr:
      ".sail/project.yaml  /adapters/codeHost no built-in adapter 'githb' fills codeHost: the built-ins that do are fake\n",
    ranFrom: false,
  });
});

// biome-ignore format: TDD-PENDING TASK-007
test
  .skip // TDD-PENDING TASK-007
  ('the adapters are resolved before the type-check: a missing token and a type error print the token refusal alone', async () => {
  const { code, stderr } = await runWith((sail) => {
    useEcho(sail);
    edit(
      sail,
      WORKFLOW,
      "import { workflow } from 'sail';",
      "import { workflow } from 'sail';\nconst bad: number = 'x';\nexport const unused = bad;",
    );
  });
  expect(stderr).toContain('/adapters/harness needs ECHO_HARNESS_TOKEN, which is not set');
  expect(stderr).not.toMatch(/TS\d+/);
  expect(code).toBe(EXIT_REFUSED);
});

// biome-ignore format: TDD-PENDING TASK-007
test
  .skip // TDD-PENDING TASK-007
  ('a model alias the config does not define refuses the run with exit 3, naming the stages and the alias', async () => {
  await withTempRepo(async (repo) => {
    const sail = copyFixture(repo.dir);
    edit(
      sail,
      'project.yaml',
      'models: { default: claude-sonnet-5, deep: claude-opus-5-5 }',
      'models: { default: claude-sonnet-5 }',
    );
    const { code, stderr } = await runCaptured(['FAKE-1'], repo.dir);
    expect(stderr).toContain("sail FAKE-1: stage 'self-review' names the model alias 'deep'");
    expect(stderr).toContain("stage 'spec' names the model alias 'deep'");
    expect(code).toBe(EXIT_REFUSED);
    expect(existsSync(join(repo.dir, '.sail-runs'))).toBe(false);
  });
});

// Agent stages end to end: `sail FAKE-1` on brief-to-spec and the fake harness, at no cost. Each case scripts what the
// tries of spec#1 do, then reads the terminal view, the exit code and the run directory.

/** `sail FAKE-1` on brief-to-spec in `repoDir`: what it printed, with durations normalised, and its run directory. */
async function agentRun(repoDir: string): Promise<Captured & { view: string; dir: string; runId: string }> {
  const captured = await runCaptured(RUN_ARGV, repoDir);
  expect(captured.stderr).toBe('');
  const dir = runDirIn(repoDir);
  return { ...captured, view: normaliseDurations(captured.stdout), dir, runId: basename(dir) };
}

/** The view's lines that start or end a call, in a key column 9 wide: `publish#1`. */
const marked = (view: string): string[] => view.split('\n').filter((line) => /^\S+ +[▶✓✗⊘] /.test(line));

const summaryIn = (dir: string): Summary => JSON.parse(readFileSync(join(dir, 'summary.json'), 'utf8'));
const callIn = (summary: Summary, key: string) => summary.calls.find((call) => call.key === key);

// biome-ignore format: TDD-PENDING TASK-007
test
  .skip // TDD-PENDING TASK-007
  ('sail FAKE-1 takes a script-to-agent workflow to its end on the fake harness, correcting an invalid output once: both tries in the view, exit 0, a run directory that validates and each session counted once', async () => {
  await withTempRepo(async (repo) => {
    writeAgentFixture(repo.dir, [submits(NO_TASKS, 0.125, { turns: 2 }), submits(SPEC, 0.25)]);
    const { code, stderr, view, dir, runId } = await agentRun(repo.dir);

    expect(marked(view)).toEqual([
      'intake#1   ▶ intake ticket · builtin',
      'intake#1   ✓ passed',
      'brief#1    ▶ brief · script',
      'brief#1    ✓ passed · <t>',
      'spec#1     ▶ spec · agent · claude-opus-5-5',
      'spec#1     ✗ error · <t>',
      'spec#1     ▶ spec · agent · claude-opus-5-5 · try 2',
      'spec#1     ✓ done · <t>',
      'publish#1  ▶ publish · script',
      'publish#1  ✓ passed · <t>',
    ]);
    expect(view.split('\n').filter((line) => line.startsWith('spec#1       output'))).toEqual([
      'spec#1       output invalid',
      'spec#1       output valid',
    ]);
    expect(view).toContain('expected array to have >=1 items');
    expect(view.split('\n').slice(-5)).toEqual([
      'completed · <t>',
      '  calls    4 · 3 passed, 1 done',
      expect.stringMatching(/^ {2}replays {2}\d+$/),
      `  run      .sail-runs/${runId}`,
      '',
    ]);
    expect({ code, stderr }).toEqual({ code: EXIT_OK, stderr: '' });

    expect(journaled(dir)).toEqual(['intake#1 passed', 'brief#1 passed', 'spec#1 done', 'publish#1 passed']);
    expect(validateRunDir(dir).issues.map(formatIssue)).toEqual([]);
    expect(
      [1, 2].map((n) =>
        readdirSync(specDir(dir, n))
          .filter((name) => name !== 'try-2')
          .sort(),
      ),
    ).toEqual([
      ['in', 'prompt.md', 'result.json', 'session.log', 'spec.md'],
      ['in', 'prompt.md', 'result.json', 'session.log', 'spec.md'],
    ]);
    expect(specFile(dir, 'prompt.md', 2)).toContain(NO_TASKS_MESSAGE);

    // Usage: each session's last update is what it ended with, the run's totals hold both sessions once, and the
    // call's own facts are its last session's.
    const events = readEvents(dir);
    expect(sessions(events)).toEqual([
      'start fake-session-spec-1',
      'end fake-session-spec-1 done 0.125',
      'start fake-session-spec-1-try-2',
      'end fake-session-spec-1-try-2 done 0.25',
    ]);
    let last = Number.NaN;
    const agreed: [number, number][] = [];
    for (const event of events) {
      if (event.type === 'usage:update') last = event.costUsdSoFar;
      if (event.type === 'harness:session_end') agreed.push([last, event.usage.costUsd]);
    }
    expect(agreed).toEqual([
      [0.125, 0.125],
      [0.25, 0.25],
    ]);
    const summary = summaryIn(dir);
    expect(summary.totals).toMatchObject({
      stageCalls: 4,
      steps: 4,
      usage: { inputTokens: 3000, outputTokens: 300, costUsd: 0.375 },
    });
    expect(callIn(summary, 'spec#1')).toMatchObject({
      kind: 'agent',
      outcome: 'done',
      turns: 1,
      toolCalls: 0,
      denials: 0,
      costUsd: 0.25,
      resultPath: '02-spec/call-1/try-2/result.json',
    });
    // Rebuilt from the events alone, the summary is the file the run wrote.
    const written = readFileSync(join(dir, 'summary.json'), 'utf8');
    rmSync(join(dir, 'summary.json'));
    expect(rebuildSummary(dir)).toEqual({ summary, path: join(dir, 'summary.json') });
    expect(readFileSync(join(dir, 'summary.json'), 'utf8')).toBe(written);
  });
}, 30_000);

// biome-ignore format: TDD-PENDING TASK-007
test
  .skip // TDD-PENDING TASK-007
  ('sail FAKE-1 fails with stage_error once the output is invalid twice, naming the problems of both tries in order', async () => {
  await withTempRepo(async (repo) => {
    writeAgentFixture(repo.dir, [submits(NO_TASKS, 0.125), submits(NO_SUMMARY, 0.25), submits(SPEC, 0.5)]);
    const { code, view, dir } = await agentRun(repo.dir);

    expect(readStatus(dir)).toEqual({ status: 'failed', stopReason: 'stage_error' });
    expect(code).toBe(EXIT_FAILED);
    const reason = entryOf(dir, 'spec#1')?.reason ?? '';
    const at = [
      reason.indexOf('invalid_output: '),
      reason.indexOf(NO_TASKS_MESSAGE),
      reason.indexOf(NO_SUMMARY_MESSAGE),
    ];
    expect(at).not.toContain(-1);
    expect(at).toEqual([...at].sort((a, b) => a - b));
    expect(marked(view).slice(4)).toEqual([
      'spec#1     ▶ spec · agent · claude-opus-5-5',
      'spec#1     ✗ error · <t>',
      'spec#1     ▶ spec · agent · claude-opus-5-5 · try 2',
      'spec#1     ✗ error · <t>',
    ]);
    expect(view).toContain('  stop     stage_error: spec#1 ended in error: invalid_output: ');
    expect([view.includes('expected array to have >=1 items'), view.includes('received undefined')]).toEqual([
      true,
      true,
    ]);
    expect(existsSync(specDir(dir, 3))).toBe(false);
    const summary = summaryIn(dir);
    expect([summary.status, summary.stopReason, summary.totals.usage.costUsd]).toEqual([
      'failed',
      'stage_error',
      0.375,
    ]);
    expect(callIn(summary, 'spec#1')).toMatchObject({
      outcome: 'error',
      resultPath: '02-spec/call-1/try-2/result.json',
    });
    expect(validateRunDir(dir).issues.map(formatIssue)).toEqual([]);
  });
}, 30_000);

// biome-ignore format: TDD-PENDING TASK-007
test
  .skip // TDD-PENDING TASK-007
  ('sail FAKE-1 fails the workflow with the reason of a blocked agent stage', async () => {
  await withTempRepo(async (repo) => {
    const reason = 'The brief has no acceptance criteria.';
    writeAgentFixture(repo.dir, [{ outcome: 'blocked', reason, usage: usageOf(0.125) }]);
    const { code, view, dir } = await agentRun(repo.dir);

    expect(readStatus(dir)).toEqual({ status: 'failed', stopReason: 'workflow_failed' });
    expect(view).toContain(`  stop     workflow_failed: spec blocked: ${reason}`);
    expect(marked(view).slice(4)).toEqual([
      'spec#1     ▶ spec · agent · claude-opus-5-5',
      'spec#1     ⊘ blocked · <t>',
    ]);
    expect(view).toContain('  calls    3 · 2 passed, 1 blocked');
    expect(code).toBe(EXIT_FAILED);
    expect(summaryIn(dir).totals.usage).toEqual(usageOf(0.125));
    expect(validateRunDir(dir).issues.map(formatIssue)).toEqual([]);
  });
}, 30_000);

// biome-ignore format: TDD-PENDING TASK-007
test
  .skip // TDD-PENDING TASK-007
  ('sail FAKE-1 fails with stage_error when the harness fails, keeping its message and reporting error:harness once', async () => {
  await withTempRepo(async (repo) => {
    writeAgentFixture(repo.dir, [{ outcome: 'error', message: 'model overloaded' }, submits(SPEC, 0.25)]);
    const { code, view, dir } = await agentRun(repo.dir);

    expect(readStatus(dir)).toEqual({ status: 'failed', stopReason: 'stage_error' });
    expect(view).toContain('  stop     stage_error: spec#1 ended in error: harness: model overloaded');
    expect(view.split('\n').filter((line) => line.includes('error:harness'))).toEqual([
      'spec#1     ✗ error:harness: model overloaded',
    ]);
    expect(code).toBe(EXIT_FAILED);
    expect(existsSync(specDir(dir, 2))).toBe(false);
    expect(validateRunDir(dir).issues.map(formatIssue)).toEqual([]);
  });
}, 30_000);

// biome-ignore format: TDD-PENDING TASK-007
test
  .skip // TDD-PENDING TASK-007
  ('sail FAKE-1 stops an agent stage at its maxTurns: budget_exceeded, the usage of the turns it ran, and no second try', async () => {
  await withTempRepo(async (repo) => {
    // The step allows 4 turns, and the session needs 8.
    writeAgentFixture(repo.dir, [submits(SPEC, 0.5, { turns: 8 }), submits(SPEC, 0.25)]);
    const { code, view, dir } = await agentRun(repo.dir);

    expect(readStatus(dir)).toEqual({ status: 'failed', stopReason: 'stage_error' });
    expect(view).toContain(
      '  stop     stage_error: spec#1 ended in error: budget_exceeded: budget exceeded: maxTurns 4',
    );
    expect(code).toBe(EXIT_FAILED);
    const exceeded = readEvents(dir).flatMap((event) => (event.type === 'budget:exceeded' ? [event] : []));
    expect(exceeded.map(({ key, budget, limit, used }) => ({ key, budget, limit, used }))).toEqual([
      { key: 'spec#1', budget: 'turns', limit: 4, used: 4 },
    ]);
    expect(sessions(readEvents(dir))).toEqual(['start fake-session-spec-1', 'end fake-session-spec-1 error 0.25']);
    expect(existsSync(specDir(dir, 2))).toBe(false);
    expect(summaryIn(dir).totals.usage).toEqual(usageOf(0.25));
    expect(validateRunDir(dir).issues.map(formatIssue)).toEqual([]);
  });
}, 30_000);

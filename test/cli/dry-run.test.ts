// `sail <ticket> --dry-run`, in process through run(), on a copy of the fixture repository: the start's whole preflight
// and the roster it would freeze, printed, with nothing written. Each case has a temp repository of its own, since a
// dry run claims its `.sail/` for the process as a start does. The command runs with `SAIL_HOME` in the repository's
// own HOME, so the machine registry it must not write is the temp HOME's.
import { expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { EXIT_OK, EXIT_REFUSED } from '../../src/cli/exit-codes';
import { fakeAdapters } from '../helpers/adapters';
import { copyFixture, edit } from '../helpers/fixture';
import { type Captured, runCaptured } from '../helpers/run-captured';
import { type TempRepo, withTempRepo } from '../helpers/temp-repo';

const WORKFLOW = 'workflows/ticket-to-pr/workflow.ts';
const BRANCH = 'sail/FAKE-1-add-a-shout-flag-to-the-greet-command';
const HOLDER = 'FAKE-1-01M3BWNZM08Q4T6V2XRJ5KWD3N';
const NOTHING_WRITTEN = 'dry run: nothing was written: no run directory, workspace, lease, claim or comment';

/** The fixture's roster, as `sail FAKE-1 --dry-run` prints it. */
const ROSTER = [
  'ticket-to-pr@1 on FAKE-1: Add a --shout flag to the greet command (Todo)',
  `  branch    ${BRANCH}`,
  '  adapters  ticketSource fake (builtin), codeHost fake (builtin), harness fake (builtin), workspace fake (builtin)',
  '  budget    run $25, 90 min',
  'intake ticket  builtin',
  '  produces  ticket.json, brief.md',
  'stage implement  agent  repo:.sail/stages/implement',
  '  model     claude-sonnet-5',
  '  budget    60 turns, $5, 20 min',
  '  produces  diff.patch',
  '  read      **',
  '  write     src/**, test/**, $STAGE_OUT/**',
  '  commands  bun test*, git add *, git commit *, git diff *',
  'stage publish  steps  repo:.sail/workflows/ticket-to-pr/stages/publish',
  '  step describe  agent',
  '    model     claude-sonnet-5',
  '    budget    20 turns, $1, 5 min',
  '    produces  pr-body.md',
  '    read      **',
  '    write     $STAGE_OUT/**',
  '    commands  git log *, git diff *',
  '  step open  script',
  'stage self-review  agent  repo:.sail/workflows/ticket-to-pr/stages/self-review',
  '  model     claude-opus-5-5',
  '  budget    30 turns, $2, 10 min',
  '  produces  review.md',
  '  read      **',
  '  write     $STAGE_OUT/**',
  '  commands  git log *, git diff *',
  'stage spec  agent  repo:.sail/workflows/ticket-to-pr/stages/spec',
  '  model     claude-opus-5-5',
  '  budget    40 turns, $2, 10 min',
  '  produces  spec.md',
  '  read      **',
  '  write     $STAGE_OUT/**',
  '  commands  git log *, git diff *',
  'stage tests  script  repo:.sail/stages/tests',
  '  produces  junit.xml',
  '  exit      passed 0, failed 1',
  NOTHING_WRITTEN,
  '',
].join('\n');

/** What a dry run must leave as it was: every file but `.git/`'s, the worktrees, git's status, and the registry. */
function traces(repo: TempRepo) {
  const glob = new Bun.Glob('**/*');
  const files = [...glob.scanSync({ cwd: repo.dir, dot: true, onlyFiles: true })]
    .filter((file) => !file.startsWith('.git/'))
    .sort();
  return {
    files,
    worktrees: repo.git('worktree', 'list', '--porcelain'),
    status: repo.git('status', '--porcelain'),
    registry: existsSync(join(repo.home, '.sail')),
  };
}

/** `sail <argv>` in a fresh copy of the fixture changed by `prepare`, with what it left behind before and after. */
async function dryIn(
  argv: string[],
  prepare: (repo: TempRepo) => Promise<void> | void = () => undefined,
): Promise<Captured & { before: ReturnType<typeof traces>; after: ReturnType<typeof traces> }> {
  return withTempRepo(async (repo) => {
    copyFixture(repo.dir);
    await prepare(repo);
    const before = traces(repo);
    const env = { ...repo.env, SAIL_HOME: join(repo.home, '.sail') };
    const captured = await runCaptured(argv, repo.dir, { env });
    return { ...captured, before, after: traces(repo) };
  });
}

/** Leases the fixture's FAKE-1 branch to a run of this process, as a live start would hold it. */
async function leaseBranch(repo: TempRepo): Promise<void> {
  const { workspace } = (await fakeAdapters(repo.dir)).ports;
  const runDir = join(repo.dir, '.sail-runs', HOLDER);
  const taken = await workspace.lease('fake://origin', BRANCH, { runId: HOLDER, runDir, pid: process.pid });
  if (!taken.leased) throw new Error('the branch was already leased');
}

test('sail FAKE-1 --dry-run prints the roster the run would freeze and exits 0, and leaves the files, worktrees, git status and registry as they were', async () => {
  const { code, stdout, stderr, before, after } = await dryIn(['FAKE-1', '--dry-run']);
  expect({ code, stdout, stderr }).toEqual({ code: EXIT_OK, stdout: ROSTER, stderr: '' });
  expect(after).toEqual(before);
  expect([after.files.some((file) => file.startsWith('.sail-runs/')), after.registry]).toEqual([false, false]);
}, 60_000);

test.each<[string, string, (repo: TempRepo) => Promise<void> | void, string]>([
  [
    'a ticket that is not designated',
    'FAKE-3',
    () => undefined,
    "sail FAKE-3: the ticket is not designated: it carries no 'sail' label. --force runs it anyway\n",
  ],
  [
    'a ticket already In Progress',
    'FAKE-2',
    () => undefined,
    'sail FAKE-2: the ticket is already claimed: it is In Progress. --force runs it anyway\n',
  ],
  [
    'a branch a live run holds',
    'FAKE-1',
    leaseBranch,
    `sail FAKE-1: the branch ${BRANCH} is leased by run ${HOLDER} (starting)\n`,
  ],
])(
  '--dry-run on %s exits 3 with the refusal of a start, and writes nothing',
  async (_, ticket, prepare, refusal) => {
    const { code, stdout, stderr, before, after } = await dryIn([ticket, '--dry-run'], prepare);
    expect({ code, stdout, stderr }).toEqual({ code: EXIT_REFUSED, stdout: '', stderr: refusal });
    expect(after).toEqual(before);
  },
  60_000,
);

test('--dry-run on a workflow with a type error prints it where it is, then exits 3 with the refusal of a start, and writes nothing', async () => {
  const { code, stdout, stderr, before, after } = await dryIn(['FAKE-1', '--dry-run'], (repo) => {
    edit(
      join(repo.dir, '.sail'),
      WORKFLOW,
      "import { workflow } from 'sail';",
      "import { workflow } from 'sail';\nconst bad: number = 'x';\nexport const unused = bad;",
    );
  });
  const [diagnostic, refusal, ...rest] = stderr.split('\n');
  expect(diagnostic).toMatch(/^\.sail\/workflows\/ticket-to-pr\/workflow\.ts:\d+:\d+ {2}TS2322 {2}/);
  expect({ code, stdout, refusal, rest }).toEqual({
    code: EXIT_REFUSED,
    stdout: '',
    refusal: 'sail FAKE-1: 1 type error in .sail/workflows/ticket-to-pr/workflow.ts',
    rest: [''],
  });
  expect(after).toEqual(before);
}, 60_000);

test('--dry-run --force on a ticket that is not designated exits 0 and lists designation as forced', async () => {
  const { code, stdout, stderr, after } = await dryIn(['FAKE-3', '--dry-run', '--force']);
  expect({ code, stderr }).toEqual({ code: EXIT_OK, stderr: '' });
  expect(stdout.split('\n').slice(0, 5)).toEqual([
    'ticket-to-pr@1 on FAKE-3: Document the greet command (Todo)',
    '  branch    sail/FAKE-3-document-the-greet-command',
    '  adapters  ticketSource fake (builtin), codeHost fake (builtin), harness fake (builtin), workspace fake (builtin)',
    '  budget    run $25, 90 min',
    '  forced    designation',
  ]);
  expect(after.files.some((file) => file.startsWith('.sail-runs/'))).toBe(false);
}, 60_000);

test('--dry-run --until spec exits 0 with the roster, and --until naming no stage exits 3 with the refusal of a start', async () => {
  const fits = await dryIn(['FAKE-1', '--dry-run', '--until', 'spec']);
  expect({ code: fits.code, stdout: fits.stdout, stderr: fits.stderr }).toEqual({
    code: EXIT_OK,
    stdout: ROSTER,
    stderr: '',
  });
  const unfit = await dryIn(['FAKE-1', '--dry-run', '--until', 'nope']);
  expect({ code: unfit.code, stdout: unfit.stdout, stderr: unfit.stderr }).toEqual({
    code: EXIT_REFUSED,
    stdout: '',
    stderr:
      "sail FAKE-1: --until names 'nope', which is no stage of workflow 'ticket-to-pr': its stages are implement, publish, self-review, spec, tests\n",
  });
  expect(unfit.after).toEqual(unfit.before);
}, 60_000);

test('--dry-run with --dispatch is refused with exit 3, and writes nothing', async () => {
  const { code, stdout, stderr, before, after } = await dryIn([
    'FAKE-1',
    '--dry-run',
    '--dispatch',
    `FAKE-1-${'0'.repeat(26)}`,
  ]);
  expect({ code, stdout, stderr }).toEqual({
    code: EXIT_REFUSED,
    stdout: '',
    stderr: "sail FAKE-1: --dry-run and --dispatch can't be combined\n",
  });
  expect(after).toEqual(before);
}, 60_000);

test('--dry-run with --head-sha is refused with exit 3, and writes nothing', async () => {
  const { code, stdout, stderr, before, after } = await dryIn(['FAKE-1', '--dry-run', '--head-sha', '0'.repeat(40)]);
  expect({ code, stdout, stderr }).toEqual({
    code: EXIT_REFUSED,
    stdout: '',
    stderr: "sail FAKE-1: --dry-run and --head-sha can't be combined\n",
  });
  expect(after).toEqual(before);
}, 60_000);

test('--dry-run prints a stage of several steps as its steps, each with what it declares', async () => {
  const { code, stdout } = await dryIn(['FAKE-1', '--dry-run']);
  const lines = stdout.split('\n');
  const from = lines.indexOf('stage publish  steps  repo:.sail/workflows/ticket-to-pr/stages/publish');
  const to = lines.findIndex((line, i) => i > from && line.startsWith('stage '));
  expect([code, lines.slice(from, to)]).toEqual([
    EXIT_OK,
    [
      'stage publish  steps  repo:.sail/workflows/ticket-to-pr/stages/publish',
      '  step describe  agent',
      '    model     claude-sonnet-5',
      '    budget    20 turns, $1, 5 min',
      '    produces  pr-body.md',
      '    read      **',
      '    write     $STAGE_OUT/**',
      '    commands  git log *, git diff *',
      '  step open  script',
    ],
  ]);
}, 60_000);

test('the usage lists --dry-run among the options of a start from a ticket', async () => {
  const { stdout } = await runCaptured(['--help']);
  const block = stdout.split('\n\n').find((part) => part.startsWith('Starting a run from a ticket:')) ?? '';
  expect(block).toMatch(
    /^ {2}--dry-run {2,}Runs every check a start runs and prints the roster it would freeze; writes nothing$/m,
  );
});

test('--dry-run prints a harness field under the model of a stage whose alias names a named harness, and none for the others', async () => {
  const { code, stdout } = await dryIn(['FAKE-1', '--dry-run'], (repo) => {
    const sail = join(repo.dir, '.sail');
    edit(
      sail,
      'project.yaml',
      'harness: { use: fake }',
      'harness: { use: fake }\n  harnesses: { second: { use: fake } }',
    );
    edit(sail, 'project.yaml', 'deep: claude-opus-5-5', 'deep: { harness: second, model: claude-opus-5-5 }');
  });
  expect(code).toBe(EXIT_OK);
  expect(stdout).toBe(
    ROSTER.replaceAll('  model     claude-opus-5-5\n', '  model     claude-opus-5-5\n  harness   second\n').replace(
      'workspace fake (builtin)\n',
      'workspace fake (builtin), harnesses.second fake (builtin)\n',
    ),
  );
}, 60_000);

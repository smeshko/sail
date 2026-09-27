// `sail run`, in process through run(): a workflow of the stub repository, from the type-check to the exit code. Each
// case has a temp repository of its own, because a process opens one run per .sail/.
import { expect, test } from 'bun:test';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { EXIT_FAILED, EXIT_INTERNAL, EXIT_OK, EXIT_REFUSED } from '../../src/cli/exit-codes';
import { edit } from '../helpers/fixture';
import { type Captured, runCaptured } from '../helpers/run-captured';
import { type StubOptions, writeStub } from '../helpers/stub-workflow';
import { withTempRepo } from '../helpers/temp-repo';

const WORKFLOW = 'workflows/ticket-to-pr/workflow.ts';

/** `sail <argv>` in a fresh stub repository changed by `change`, with the ids of the runs it left. */
async function sailIn(
  argv: string[],
  options: StubOptions = {},
  change: (sail: string) => void = () => undefined,
): Promise<Captured & { lines: string[]; runs: string[] }> {
  return withTempRepo(async (repo) => {
    change(writeStub(repo.dir, options));
    const captured = await runCaptured(argv, repo.dir);
    const runsDir = join(repo.dir, '.sail-runs');
    const runs = existsSync(runsDir) ? readdirSync(runsDir) : [];
    return { ...captured, lines: captured.stdout.trimEnd().split('\n'), runs };
  });
}

test("sail run runs the default workflow to completion, a line per call, then the run's", async () => {
  const { code, lines, stderr, runs } = await sailIn(['run']);
  expect(runs).toHaveLength(1);
  const [runId] = runs;
  expect(runId).toMatch(/^LOCAL-[0-9A-Z]{26}$/);
  expect(lines).toEqual([
    'spec#1 passed',
    'implement#1 passed',
    'tests#1 failed',
    'implement#2 passed',
    'tests#2 passed',
    'self-review#1 passed',
    'publish#1 passed',
    `${runId} completed  .sail-runs/${runId}`,
  ]);
  expect(stderr).toBe('');
  expect(code).toBe(EXIT_OK);
});

test('a run whose tests never pass exits 1, naming its stop reason and why', async () => {
  const { code, lines, runs } = await sailIn(['run', '--workflow', 'ticket-to-pr'], { testsPassAt: 99 });
  const [runId] = runs;
  expect(lines.at(-2)).toBe('tests#3 failed');
  expect(lines.at(-1)).toBe(`${runId} failed workflow_failed: loop "fix" exceeded 3  .sail-runs/${runId}`);
  expect(code).toBe(EXIT_FAILED);
});

test('a call that ends in error exits 1 with stage_error', async () => {
  const { code, lines } = await sailIn(['run'], {}, (sail) =>
    edit(sail, 'stages/tests/run.sh', 'pass_at=2\n', 'exit 2\n'),
  );
  expect(lines.at(-2)).toBe('tests#1 error');
  expect(lines.at(-1)).toContain(
    ' failed stage_error: tests#1 ended in error: exit_code: exit code 2 is not mapped to passed or failed  .sail-runs/',
  );
  expect(code).toBe(EXIT_FAILED);
});

test('a valid --input runs', async () => {
  const input = { ticketKey: 'FAKE-4', title: 'Greet', url: 'fake://tickets/FAKE-4', acceptanceCriteria: [] };
  const { code, lines } = await sailIn(['run', '--input', JSON.stringify(input)], { testsPassAt: 1 });
  expect(lines.at(-1)).toContain(' completed  .sail-runs/LOCAL-');
  expect(code).toBe(EXIT_OK);
});

test.each<[string, string[], (sail: string) => void, string]>([
  [
    'an unknown workflow',
    ['run', '--workflow', 'nope'],
    () => undefined,
    "no workflow 'nope': .sail/workflows/nope/workflow.ts doesn't exist",
  ],
  [
    'a name that is not a workflow name',
    ['run', '--workflow', '../stages'],
    () => undefined,
    "'../stages' is not a workflow name",
  ],
  [
    'a type error in the workflow',
    ['run'],
    (sail) => edit(sail, WORKFLOW, "{ spec: s.files['spec.md'], feedback: iteration.previous }", '{}'),
    '1 type error in .sail/workflows/ticket-to-pr/workflow.ts',
  ],
  ['--input that is not JSON', ['run', '--input', '{'], () => undefined, '--input is not JSON: '],
  [
    "--input the intake's schema rejects",
    ['run', '--input', '{"x":1}'],
    () => undefined,
    "the input doesn't match intake 'ticket':",
  ],
  [
    'no --workflow, and no defaultWorkflow',
    ['run'],
    (sail) => edit(sail, 'project.yaml', 'defaultWorkflow: ticket-to-pr\n', ''),
    'no --workflow given, and .sail/project.yaml sets no defaultWorkflow',
  ],
])('%s is refused with exit 3, and no run directory is created', async (_, argv, change, message) => {
  const { code, stdout, stderr, runs } = await sailIn(argv, {}, change);
  expect(stderr).toContain(`sail run: ${message}`);
  expect(stdout).toBe('');
  expect(runs).toEqual([]);
  expect(code).toBe(EXIT_REFUSED);
});

test('a type error is printed where it is, before the refusal', async () => {
  const { stderr } = await sailIn(['run'], {}, (sail) =>
    edit(sail, WORKFLOW, "{ spec: s.files['spec.md'], feedback: iteration.previous }", '{}'),
  );
  expect(stderr).toMatch(/^\.sail\/workflows\/ticket-to-pr\/workflow\.ts:\d+:\d+ {2}TS2741 {2}/);
});

test('a project.yaml that breaks its schema is refused with its issues', async () => {
  const { code, stderr, runs } = await sailIn(['run'], {}, (sail) =>
    edit(sail, 'project.yaml', 'adapters:\n', 'no-adapters:\n'),
  );
  expect(stderr).toContain('.sail/project.yaml  [sail.project.v1]  /adapters is required');
  expect(runs).toEqual([]);
  expect(code).toBe(EXIT_REFUSED);
});

test('outside a git repository, sail run is refused', async () => {
  await withTempRepo(async (repo) => {
    const { code, stderr } = await runCaptured(['run'], repo.home);
    expect(stderr).toBe(`sail run: not inside a git repository: ${repo.home}\n`);
    expect(code).toBe(EXIT_REFUSED);
  });
});

test('a journal corrupted mid-run is an internal error, exit 4', async () => {
  const { code, stderr } = await sailIn(['run'], {}, (sail) =>
    edit(
      sail,
      'workflows/ticket-to-pr/stages/spec/run.sh',
      "printf '# Spec",
      'echo not-json >>"$STAGE_OUT/../../journal.ndjson"\nprintf \'# Spec',
    ),
  );
  expect(stderr).toStartWith('sail: internal error: ');
  expect(stderr).toContain('journal.ndjson:1 is not valid JSON');
  expect(code).toBe(EXIT_INTERNAL);
});

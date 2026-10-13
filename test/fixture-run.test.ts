// The fixture repository's `ticket-to-pr`, end to end through the CLI on the fakes: `sail FAKE-1` in a temporary
// repository that holds a copy of the fixture's `.sail/`, from its ticket to pull request 5. The fake harness replays
// the answers `.sail/fake/harness.json` scripts, the tests stub fails once, and `open` reaches the fake code host
// through `sail port codehost`, in real child processes.
//
// One run per `.sail/` per process: the cases that only read what a completed run left share one run, and the
// interrupt, its resume and the forced second run each have a repository of their own.
import { afterAll, expect, test } from 'bun:test';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { HarnessScript } from '../src/adapters/fake/harness';
import { EXIT_FAILED, EXIT_OK, EXIT_SUSPENDED, type ExitCode } from '../src/cli/exit-codes';
import { readJournal } from '../src/engine/journal';
import { validateRunDir } from '../src/engine/schemas';
import { readEvents } from '../src/events/consumers/ndjson';
import type { SailEvent } from '../src/events/types';
import { interruptInSession, journaled, writeHarnessScript } from './helpers/agent-fixture';
import { copyFixture, FIXTURE_SAIL } from './helpers/fixture';
import { fakeInterrupts, runCaptured } from './helpers/run-captured';
import { copyRun } from './helpers/stub-workflow';
import { type TempRepo, withTempRepo } from './helpers/temp-repo';

const JOURNAL = [
  'intake#1 passed',
  'spec#1 done',
  'implement#1 done',
  'tests#1 failed',
  'implement#2 done',
  'tests#2 passed',
  'self-review#1 done',
  'describe#1 done',
  'open#1 passed',
];
const PR = { number: 5, url: 'fake://codehost/fixture/pull/5', draft: false };
const CONFLICT = 'sail port: codeHost.openPullRequest: #5 is already open from sail/FAKE-1 into main (conflict)';

/** The run directory of a repository's latest run, or '' when it has none. */
function latestRun(repoDir: string): string {
  const runs = join(repoDir, '.sail-runs');
  const ids = existsSync(runs) ? readdirSync(runs).filter((name) => name !== 'fake') : [];
  const last = ids.sort().at(-1);
  return last === undefined ? '' : join(runs, last);
}

/** What the journal of the run in `dir` holds, as `<key> <outcome>`, or nothing when there is no run. */
const journalOf = (dir: string): string[] => (dir === '' ? [] : journaled(dir));
const json = (...path: string[]) => JSON.parse(readFileSync(join(...path), 'utf8'));
/** What a fake keeps of what it changed: its state file under `.sail-runs/fake/`. */
const fakeState = (repoDir: string, name: string) => json(repoDir, '.sail-runs', 'fake', name);

interface Ran {
  repo: TempRepo;
  code: ExitCode;
  stdout: string;
  stderr: string;
  /** The run directory, or '' when the run left none. */
  dir: string;
}

let release = (): void => {};
let shared: Promise<Ran> | undefined;

/** `sail FAKE-1` in a copy of the fixture repository, run once and kept until the file's last case. */
function fixtureRun(): Promise<Ran> {
  shared ??= new Promise<Ran>((resolve, reject) => {
    withTempRepo(async (repo) => {
      copyFixture(repo.dir);
      const captured = await runCaptured(['FAKE-1'], repo.dir, { env: repo.env });
      resolve({ repo, ...captured, dir: latestRun(repo.dir) });
      await new Promise<void>((done) => {
        release = done;
      });
    }).catch(reject);
  });
  return shared;
}
afterAll(() => release());

/** The shared run, which must have completed: every case below reads what it left. */
async function completed(): Promise<Ran & { events: SailEvent[]; runId: string }> {
  const ran = await fixtureRun();
  expect([ran.code, journalOf(ran.dir)]).toEqual([EXIT_OK, JOURNAL]);
  return { ...ran, events: readEvents(ran.dir), runId: ran.dir.split('/').at(-1) ?? '' };
}

// biome-ignore format: TDD-PENDING TASK-011
test
  .skip // TDD-PENDING TASK-011
  ('sail FAKE-1 takes ticket-to-pr from its ticket to a pull request: it exits 0 with nine journal lines, in call directories 00-intake to 06-open, where implement and tests each ran twice', async () => {
  const { dir, stderr, stdout } = await completed();
  expect(stderr).toBe('');
  expect(stdout).toContain('\ncompleted · ');
  const stages = readdirSync(dir).filter((name) => /^\d\d-/.test(name));
  expect(stages.sort()).toEqual([
    '00-intake',
    '01-spec',
    '02-implement',
    '03-tests',
    '04-self-review',
    '05-describe',
    '06-open',
  ]);
  expect(stages.sort().map((stage) => readdirSync(join(dir, stage)).sort())).toEqual([
    ['call-1'],
    ['call-1'],
    ['call-1', 'call-2'],
    ['call-1', 'call-2'],
    ['call-1'],
    ['call-1'],
    ['call-1'],
  ]);
  expect(readFileSync(join(dir, 'STATUS'), 'utf8')).toBe('completed\n');
});

// biome-ignore format: TDD-PENDING TASK-011
test
  .skip // TDD-PENDING TASK-011
  ('implement#2 consumed the failing report as its feedback, and implement#1 consumed none', async () => {
  const { dir } = await completed();
  const [first, second] = [1, 2].map((call) => json(dir, '02-implement', `call-${call}`, 'result.json'));
  expect([first.consumed, second.consumed]).toEqual([
    { spec: '01-spec/call-1/spec.md', feedback: null },
    { spec: '01-spec/call-1/spec.md', feedback: '03-tests/call-1/result.json#/output' },
  ]);
  const report = json(dir, '03-tests', 'call-1', 'result.json').output;
  expect(report).toMatchObject({ ok: false, total: 6, failed: 1 });
  expect(json(dir, '02-implement', 'call-2', 'in', 'feedback.json')).toEqual(report);
  expect(existsSync(join(dir, '02-implement', 'call-1', 'in', 'feedback.json'))).toBe(false);
});

// biome-ignore format: TDD-PENDING TASK-011
test
  .skip // TDD-PENDING TASK-011
  ("the run leaves pull request 5 on the fake code host: open, no draft, from sail/FAKE-1 into main at the repository's HEAD, labelled sail, with the ticket key, the title describe submitted and the body of its pr-body.md", async () => {
  const { dir, repo } = await completed();
  const { pullRequests, branches } = fakeState(repo.dir, 'prs.json');
  expect(pullRequests.map((pr: { number: number }) => pr.number)).toEqual([1, 2, 3, 4, 5]);
  const described = json(dir, '05-describe', 'call-1', 'result.json').output;
  expect(described).toEqual({ title: 'Add a --shout flag to the greet command (FAKE-1)', bodyFile: 'pr-body.md' });
  const headSha = repo.git('rev-parse', 'HEAD');
  expect(pullRequests[4]).toMatchObject({
    number: 5,
    title: described.title,
    body: readFileSync(join(dir, '05-describe', 'call-1', 'pr-body.md'), 'utf8'),
    base: 'main',
    head: 'sail/FAKE-1',
    headSha,
    draft: false,
    state: 'open',
    labels: ['sail'],
    ticketKey: 'FAKE-1',
  });
  expect(pullRequests[4].body).toStartWith('## Summary\n');
  expect(branches['sail/FAKE-1']).toBe(headSha);
});

// biome-ignore format: TDD-PENDING TASK-011
test
  .skip // TDD-PENDING TASK-011
  ("open#1's output is the pull request's number, URL and draft flag, kept from the code host's whole answer, and run:end's result is { pr: that }", async () => {
  const { dir, events } = await completed();
  const result = json(dir, '06-open', 'call-1', 'result.json');
  expect([result.outcome, result.output]).toEqual(['passed', PR]);
  // The script's last stdout line is the whole PullRequest: the stage's schema keeps three of its fields.
  const printed = JSON.parse(readFileSync(join(dir, '06-open', 'call-1', 'stdout.log'), 'utf8').trimEnd());
  expect(Object.keys(printed)).toContain('headSha');
  expect(events.at(-1)).toMatchObject({ type: 'run:end', status: 'completed', result: { pr: PR } });
  expect(result.consumed).toEqual({ title: 'workflow', body: '05-describe/call-1/pr-body.md', ticketKey: 'workflow' });
});

// biome-ignore format: TDD-PENDING TASK-011
test
  .skip // TDD-PENDING TASK-011
  ("the events hold codehost:pushed, codehost:pr_opened and codehost:labelled under the key open#1, after open#1's script:exec and before its script:exit, and the call directory keeps them in its port events file", async () => {
  const { dir, events, repo } = await completed();
  const own = events.filter((event) => 'key' in event && event.key === 'open#1');
  const from = own.findIndex((event) => event.type === 'script:exec');
  const first = own[from]?.seq ?? 0;
  expect(own.slice(from, from + 5).map((event) => [event.type, event.seq - first])).toEqual([
    ['script:exec', 0],
    ['codehost:pushed', 1],
    ['codehost:pr_opened', 2],
    ['codehost:labelled', 3],
    ['script:exit', 4],
  ]);
  const stamped = own.slice(from + 1, from + 4) as unknown as Record<string, unknown>[];
  const provider = stamped.map(({ seq: _seq, ts: _ts, runId: _runId, key: _key, ...rest }) => rest);
  expect<unknown>(provider).toEqual([
    { type: 'codehost:pushed', branch: 'sail/FAKE-1', headSha: repo.git('rev-parse', 'HEAD') },
    { type: 'codehost:pr_opened', ...PR, base: 'main', head: 'sail/FAKE-1', ticketKey: 'FAKE-1' },
    { type: 'codehost:labelled', number: 5, label: 'sail', change: 'added' },
  ]);
  const file = readFileSync(join(dir, '06-open', 'call-1', 'port-events.ndjson'), 'utf8');
  expect(
    file
      .split('\n')
      .slice(0, -1)
      .map((line) => JSON.parse(line)),
  ).toEqual(provider);
  expect(events.filter((event) => event.type.startsWith('codehost:'))).toHaveLength(3);
});

// biome-ignore format: TDD-PENDING TASK-011
test
  .skip // TDD-PENDING TASK-011
  ("the fake's FAKE-1 is In Progress, with the comment that names the run", async () => {
  const { repo, runId } = await completed();
  const ticket = fakeState(repo.dir, 'tickets.json').tickets[0];
  expect([ticket.ticketKey, ticket.state]).toEqual(['FAKE-1', { type: 'started', name: 'In Progress' }]);
  expect(ticket.comments.at(-1)).toMatchObject({ author: 'sail', body: `sail run ${runId} started` });
});

// biome-ignore format: TDD-PENDING TASK-011
test
  .skip // TDD-PENDING TASK-011
  ('the run directory validates against the five sail.*.v1 schemas: one header, nine journal lines, nine results and one summary, with no issue', async () => {
  const { dir, events } = await completed();
  expect(validateRunDir(dir)).toEqual({
    counts: {
      'sail.run.v1': 1,
      'sail.journal.v1': 9,
      'sail.result.v1': 9,
      'sail.event.v1': events.length,
      'sail.summary.v1': 1,
    },
    issues: [],
  });
  expect(readJournal(dir).entries.map((entry) => entry.resultPath.split('/')[0])).toEqual([
    '00-intake',
    '01-spec',
    '02-implement',
    '03-tests',
    '02-implement',
    '03-tests',
    '04-self-review',
    '05-describe',
    '06-open',
  ]);
});

// biome-ignore format: TDD-PENDING TASK-011
test
  .skip // TDD-PENDING TASK-011
  ('summary.json says completed, names the ticket with its title and URL, lists the loop fix with two iterations, and totals the scripted cost of $1.35', async () => {
  const { dir } = await completed();
  const summary = json(dir, 'summary.json');
  expect({
    status: summary.status,
    ticket: summary.ticket,
    loops: summary.loops,
    costUsd: summary.totals.usage.costUsd,
    calls: summary.totals.stageCalls,
    result: summary.result,
  }).toEqual({
    status: 'completed',
    ticket: {
      ticketKey: 'FAKE-1',
      title: 'Add a --shout flag to the greet command',
      url: 'fake://tickets/FAKE-1',
    },
    loops: { fix: { iterations: 2, max: 3 } },
    costUsd: 1.35,
    calls: 9,
    result: { pr: PR },
  });
});

// biome-ignore format: TDD-PENDING TASK-011
test
  .skip // TDD-PENDING TASK-011
  ("no file of the run directory holds the temporary repository's path", async () => {
  const { dir, repo } = await completed();
  const files = readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name));
  expect(files.length).toBeGreaterThan(40);
  expect(files.filter((file) => readFileSync(file, 'utf8').includes(repo.dir))).toEqual([]);
});

/** The fixture's harness script, with `implement#2` waiting 10 s in its first try and running through in its second. */
function delayingImplement2(): HarnessScript {
  const script: HarnessScript = JSON.parse(readFileSync(join(FIXTURE_SAIL, 'fake', 'harness.json'), 'utf8'));
  const [answer] = script['implement#2'] ?? [];
  if (answer?.outcome !== 'done') throw new Error("the fixture scripts no 'done' answer for implement#2");
  return { ...script, 'implement#2': [{ ...answer, delayMs: 10_000 }, answer] };
}

// biome-ignore format: TDD-PENDING TASK-011
test
  .skip // TDD-PENDING TASK-011
  ('Ctrl-C during implement#2 exits 2 with the resume hint and a journal that ends at tests#1, and sail resume then runs implement#2 as its second try and finishes with the same nine journal lines', async () => {
  await withTempRepo(async (repo) => {
    copyFixture(repo.dir);
    writeHarnessScript(repo.dir, delayingImplement2());
    const interrupts = fakeInterrupts();
    const running = runCaptured(['FAKE-1'], repo.dir, { env: repo.env, onInterrupt: interrupts.onInterrupt });
    // The run's third session is implement#2's: spec, implement#1, then this one, waiting in its scripted delay.
    const interrupted = await interruptInSession(repo.dir, running, interrupts.interrupt, 3);
    const dir = latestRun(repo.dir);
    const runId = dir.split('/').at(-1) ?? '';
    expect([interrupted.code, journalOf(dir)]).toEqual([EXIT_SUSPENDED, JOURNAL.slice(0, 4)]);
    expect(interrupted.stdout).toEndWith(`resume it with: sail resume ${runId}\n`);
    expect(readFileSync(join(dir, 'STATUS'), 'utf8')).toBe('suspended interrupted\n');

    await withTempRepo(async (other) => {
      copyRun(repo.dir, other.dir);
      const resumed = await runCaptured(['resume', runId], other.dir, { env: other.env });
      const copy = join(other.dir, '.sail-runs', runId);
      expect([resumed.code, resumed.stderr, journalOf(copy)]).toEqual([EXIT_OK, '', JOURNAL]);
      expect(readJournal(copy).entries[4]).toMatchObject({
        key: 'implement#2',
        resultPath: '02-implement/call-2/try-2/result.json',
      });
      expect(json(copy, '02-implement', 'call-2', 'try-2', 'result.json')).toMatchObject({ outcome: 'done', try: 2 });
      expect(fakeState(other.dir, 'prs.json').pullRequests.at(-1)).toMatchObject({
        number: 5,
        state: 'open',
        headSha: other.git('rev-parse', 'HEAD'),
      });
      expect(validateRunDir(copy).issues).toEqual([]);
    });
  });
}, 60_000);

// biome-ignore format: TDD-PENDING TASK-011
test
  .skip // TDD-PENDING TASK-011
  ("a second run of FAKE-1, forced, in a copy of a repository whose first run completed fails: its open#1 ends in error on the fake's conflict, and the run is failed with stage_error", async () => {
  const first = await completed();
  await withTempRepo(async (other) => {
    copyRun(first.repo.dir, other.dir);
    const second = await runCaptured(['FAKE-1', '--force'], other.dir, { env: other.env });
    const dir = latestRun(other.dir);
    expect(dir).not.toBe(join(other.dir, '.sail-runs', first.runId));
    expect([second.code, journalOf(dir)]).toEqual([EXIT_FAILED, [...JOURNAL.slice(0, 8), 'open#1 error']]);
    expect(readFileSync(join(dir, '06-open', 'call-1', 'stderr.log'), 'utf8')).toBe(`${CONFLICT}\n`);
    expect(json(dir, '06-open', 'call-1', 'result.json')).toMatchObject({
      outcome: 'error',
      output: null,
      errors: [{ reason: 'exit_code', message: 'exit code 1 is not mapped to passed or failed' }],
    });
    expect(readFileSync(join(dir, 'STATUS'), 'utf8')).toBe('failed stage_error\n');
    // The push went through before the refusal, and its event is in the stream. No second pull request was opened.
    const hosted = readEvents(dir).flatMap((event) => (event.type.startsWith('codehost:') ? [event.type] : []));
    expect(hosted).toEqual(['codehost:pushed']);
    expect(fakeState(other.dir, 'prs.json').pullRequests).toHaveLength(5);
  });
}, 60_000);

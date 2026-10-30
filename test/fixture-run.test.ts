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
import type { HarnessScript, ScriptedAnswer } from '../src/adapters/fake/harness';
import { EXIT_FAILED, EXIT_OK, EXIT_SUSPENDED, type ExitCode } from '../src/cli/exit-codes';
import { readJournal } from '../src/engine/journal';
import { validateRunDir } from '../src/engine/schemas';
import { readEvents } from '../src/events/consumers/ndjson';
import type { SailEvent } from '../src/events/types';
import { interruptInSession, journaled, writeHarnessScript } from './helpers/agent-fixture';
import { copyFixture, FIXTURE_SAIL, holdAfterOpen, holdBeforeOpen, killWhenHeld } from './helpers/fixture';
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
  'publish#1/describe done',
  'publish#1/open passed',
  'publish#1 passed',
];
const PR = { number: 5, url: 'fake://codehost/fixture/pull/5', draft: false };
const BRANCH = 'sail/FAKE-1-add-a-shout-flag-to-the-greet-command';
const MAIN = join(import.meta.dir, '..', 'src', 'cli', 'main.ts');

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

test('sail FAKE-1 takes ticket-to-pr from its ticket to a pull request: it exits 0 with ten journal lines, in call directories 00-intake to 05-publish, where implement and tests each ran twice', async () => {
  const { dir, stderr, stdout } = await completed();
  expect(stderr).toBe('');
  expect(stdout).toContain('\ncompleted · ');
  const stages = readdirSync(dir).filter((name) => /^\d\d-/.test(name));
  expect(stages.sort()).toEqual(['00-intake', '01-spec', '02-implement', '03-tests', '04-self-review', '05-publish']);
  expect(stages.sort().map((stage) => readdirSync(join(dir, stage)).sort())).toEqual([
    ['call-1'],
    ['call-1'],
    ['call-1', 'call-2'],
    ['call-1', 'call-2'],
    ['call-1'],
    ['call-1'],
  ]);
  expect(readFileSync(join(dir, 'STATUS'), 'utf8')).toBe('completed\n');
});

test('implement#2 consumed the failing report as its feedback, and implement#1 consumed none', async () => {
  const { dir } = await completed();
  const [first, second] = [1, 2].map((call) => json(dir, '02-implement', `call-${call}`, 'result.json'));
  expect([first.consumed, second.consumed]).toEqual([
    { spec: '01-spec/call-1/out/spec.md', feedback: null },
    { spec: '01-spec/call-1/out/spec.md', feedback: '03-tests/call-1/result.json#/output' },
  ]);
  const report = json(dir, '03-tests', 'call-1', 'result.json').output;
  expect(report).toMatchObject({ ok: false, total: 6, failed: 1 });
  expect(json(dir, '02-implement', 'call-2', 'in', 'feedback.json')).toEqual(report);
  expect(existsSync(join(dir, '02-implement', 'call-1', 'in', 'feedback.json'))).toBe(false);
});

test("the run leaves pull request 5 on the fake code host: open, no draft, from the run's branch into main at the repository's HEAD, labelled sail, with the ticket key, the title describe submitted and the body of its pr-body.md", async () => {
  const { dir, repo } = await completed();
  const { pullRequests, branches } = fakeState(repo.dir, 'prs.json');
  expect(pullRequests.map((pr: { number: number }) => pr.number)).toEqual([1, 2, 3, 4, 5]);
  const described = json(dir, '05-publish', 'call-1', 'steps', '1-describe', 'result.json').output;
  expect(described).toEqual({ title: 'Add a --shout flag to the greet command (FAKE-1)', bodyFile: 'pr-body.md' });
  const headSha = repo.git('rev-parse', 'HEAD');
  expect(pullRequests[4]).toMatchObject({
    number: 5,
    title: described.title,
    body: readFileSync(join(dir, '05-publish', 'call-1', 'out', 'pr-body.md'), 'utf8'),
    base: 'main',
    head: 'sail/FAKE-1-add-a-shout-flag-to-the-greet-command',
    headSha,
    draft: false,
    state: 'open',
    labels: ['sail'],
    ticketKey: 'FAKE-1',
  });
  expect(pullRequests[4].body).toStartWith('## Summary\n');
  expect(branches['sail/FAKE-1-add-a-shout-flag-to-the-greet-command']).toBe(headSha);
});

test("publish#1/open's output is the pull request's number, URL and draft flag, kept from the code host's whole answer, and run:end's result is { pr: that }", async () => {
  const { dir, events } = await completed();
  const result = json(dir, '05-publish', 'call-1', 'steps', '2-open', 'result.json');
  expect([result.outcome, result.output]).toEqual(['passed', PR]);
  // The script's last stdout line is the whole PullRequest: the stage's schema keeps three of its fields.
  const printed = JSON.parse(
    readFileSync(join(dir, '05-publish', 'call-1', 'steps', '2-open', 'stdout.log'), 'utf8').trimEnd(),
  );
  expect(Object.keys(printed)).toContain('headSha');
  expect(events.at(-1)).toMatchObject({ type: 'run:end', status: 'completed', result: { pr: PR } });
  expect(result.consumed).toEqual({
    title: '05-publish/call-1/steps/1-describe/result.json#/output/title',
    body: '05-publish/call-1/out/pr-body.md',
    ticketKey: 'workflow',
  });
});

test('the events hold codehost:pushed, codehost:pr_opened, codehost:labelled and ticket:commented under the key publish#1/open, after its script:exec and before its script:exit, and the call directory keeps them in its port events file', async () => {
  const { dir, events, repo, runId } = await completed();
  const own = events.filter((event) => 'key' in event && event.key === 'publish#1/open');
  const from = own.findIndex((event) => event.type === 'script:exec');
  const first = own[from]?.seq ?? 0;
  expect(own.slice(from, from + 6).map((event) => [event.type, event.seq - first])).toEqual([
    ['script:exec', 0],
    ['codehost:pushed', 1],
    ['codehost:pr_opened', 2],
    ['codehost:labelled', 3],
    ['ticket:commented', 4],
    ['script:exit', 5],
  ]);
  const stamped = own.slice(from + 1, from + 5) as unknown as Record<string, unknown>[];
  const provider = stamped.map(({ seq: _seq, ts: _ts, runId: _runId, key: _key, ...rest }) => rest);
  expect<unknown>(provider).toEqual([
    {
      type: 'codehost:pushed',
      branch: 'sail/FAKE-1-add-a-shout-flag-to-the-greet-command',
      headSha: repo.git('rev-parse', 'HEAD'),
    },
    {
      type: 'codehost:pr_opened',
      ...PR,
      base: 'main',
      head: 'sail/FAKE-1-add-a-shout-flag-to-the-greet-command',
      ticketKey: 'FAKE-1',
    },
    { type: 'codehost:labelled', number: 5, label: 'sail', change: 'added' },
    { type: 'ticket:commented', ticketKey: 'FAKE-1', body: `sail run ${runId} opened ${PR.url}` },
  ]);
  const file = readFileSync(join(dir, '05-publish', 'call-1', 'steps', '2-open', 'port-events.ndjson'), 'utf8');
  expect(
    file
      .split('\n')
      .slice(0, -1)
      .map((line) => JSON.parse(line)),
  ).toEqual(provider);
  expect(events.filter((event) => event.type.startsWith('codehost:'))).toHaveLength(3);
});

test("the fake's FAKE-1 is In Progress, with the comment that names the run and then the one that links its pull request", async () => {
  const { repo, runId } = await completed();
  const ticket = fakeState(repo.dir, 'tickets.json').tickets[0];
  expect([ticket.ticketKey, ticket.state]).toEqual(['FAKE-1', { type: 'started', name: 'In Progress' }]);
  expect(ticket.comments.slice(-2)).toMatchObject([
    { author: 'sail', body: `sail run ${runId} started` },
    { author: 'sail', body: `sail run ${runId} opened ${PR.url}` },
  ]);
});

test('the run directory validates against the five sail.*.v1 schemas: one header, ten journal lines, ten results and one summary, with no issue', async () => {
  const { dir, events } = await completed();
  expect(validateRunDir(dir)).toEqual({
    counts: {
      'sail.run.v1': 1,
      'sail.journal.v1': 10,
      'sail.result.v1': 10,
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
    '05-publish',
    '05-publish',
    '05-publish',
  ]);
});

test('summary.json says completed, names the ticket with its title and URL, lists the loop fix with two iterations, and totals the scripted cost of $1.35', async () => {
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
    calls: 8,
    result: { pr: PR },
  });
});

test("no file of the run directory holds the temporary repository's path", async () => {
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

test('Ctrl-C during implement#2 exits 2 with the resume hint and a journal that ends at tests#1, and sail resume then runs implement#2 as its second try and finishes with the same ten journal lines', async () => {
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

test('a second run of FAKE-1, forced, in a copy of a repository whose first run completed, completes with the same pull request 5, and opens no second one', async () => {
  const first = await completed();
  await withTempRepo(async (other) => {
    copyRun(first.repo.dir, other.dir);
    const second = await runCaptured(['FAKE-1', '--force'], other.dir, { env: other.env });
    const dir = latestRun(other.dir);
    expect(dir).not.toBe(join(other.dir, '.sail-runs', first.runId));
    expect([second.code, second.stderr, journalOf(dir)]).toEqual([EXIT_OK, '', JOURNAL]);
    expect(json(dir, '05-publish', 'call-1', 'result.json')).toMatchObject({ outcome: 'passed', output: PR });
    expect(readFileSync(join(dir, 'STATUS'), 'utf8')).toBe('completed\n');
    // The push went through, and the pull request already open from the branch was answered: none was announced.
    const hosted = readEvents(dir).flatMap((event) => (event.type.startsWith('codehost:') ? [event.type] : []));
    expect(hosted).toEqual(['codehost:pushed']);
    expect(fakeState(other.dir, 'prs.json').pullRequests).toHaveLength(5);
  });
}, 60_000);

test('a run killed after open-pull-request answered resumes and completes with the same pull request 5, and the fake holds one pull request from the branch', async () => {
  await withTempRepo(async (repo) => {
    holdAfterOpen(copyFixture(repo.dir));
    const held = join(repo.home, 'open.pid');
    const child = Bun.spawn([process.execPath, MAIN, 'FAKE-1'], {
      cwd: repo.dir,
      env: { ...repo.env, HOLD_AFTER_OPEN: held },
      stdin: 'ignore',
      stdout: 'ignore',
      stderr: 'ignore',
    });
    expect(await killWhenHeld(held, child)).toBe(true);
    const dir = latestRun(repo.dir);
    const runId = dir.split('/').at(-1) ?? '';
    expect(journalOf(dir)).toEqual(JOURNAL.slice(0, 8));
    const resumed = Bun.spawnSync([process.execPath, MAIN, 'resume', runId], { cwd: repo.dir, env: repo.env });
    expect([resumed.exitCode, resumed.stderr.toString(), journalOf(dir)]).toEqual([EXIT_OK, '', JOURNAL]);
    // The open step ran again, as its second try.
    const open = readJournal(dir).entries.at(-2);
    expect(open?.resultPath).toBe('05-publish/call-1/steps/2-open/try-2/result.json');
    expect(json(dir, open?.resultPath ?? '')).toMatchObject({ outcome: 'passed', output: PR });
    const fromBranch = fakeState(repo.dir, 'prs.json').pullRequests.filter(
      (pr: { head: string }) => pr.head === BRANCH,
    );
    expect(fromBranch.map((pr: { number: number }) => pr.number)).toEqual([5]);
  });
}, 60_000);

// spec's document: the template is in place before the session, and its validators check what the session left.

const SPEC_CHECKS = ['hasSections(Requirements, Tasks)', 'noPlaceholders', 'countItems(Tasks, min 1)'];

test('spec#1 completes spec.md from its template: its file:validated follows its file:produced, and its result records the three checks as valid and derived.tasks as 2', async () => {
  const { dir, events } = await completed();
  const result = json(dir, '01-spec', 'call-1', 'result.json');
  expect([result.files['spec.md'].validation, result.derived]).toEqual([
    { ok: true, checks: SPEC_CHECKS },
    { tasks: 2 },
  ]);
  const own = events.flatMap((event) => ('key' in event && event.key === 'spec#1' ? [event] : []));
  const at = own.findIndex((event) => event.type === 'file:produced');
  expect(own.slice(at, at + 2)).toMatchObject([
    { type: 'file:produced', name: 'spec.md' },
    { type: 'file:validated', name: 'spec.md', ok: true, checks: SPEC_CHECKS },
  ]);
  expect(events.filter((event) => event.type === 'file:validated')).toHaveLength(1);
});

/** The fixture's harness script, with spec's tries answered by `answers` made from its own answer. */
function specTries(...answers: ((answer: ScriptedAnswer & { outcome: 'done' }) => ScriptedAnswer)[]): HarnessScript {
  const script: HarnessScript = JSON.parse(readFileSync(join(FIXTURE_SAIL, 'fake', 'harness.json'), 'utf8'));
  const [answer] = script.spec ?? [];
  if (answer?.outcome !== 'done') throw new Error("the fixture scripts no 'done' answer for spec");
  return { ...script, spec: answers.map((make) => make(answer)) };
}

test('a first spec try that leaves the template as it is gets one correction: try-2 is told each validator message, and writes a valid spec', async () => {
  await withTempRepo(async (repo) => {
    copyFixture(repo.dir);
    writeHarnessScript(
      repo.dir,
      specTries(
        (answer) => ({ ...answer, files: {} }),
        (answer) => answer,
      ),
    );
    // Nothing after spec#1 reads the correction: the run stops there.
    const ran = await runCaptured(['FAKE-1', '--until', 'spec'], repo.dir, { env: repo.env });
    const dir = latestRun(repo.dir);
    expect([ran.code, journalOf(dir)]).toEqual([EXIT_SUSPENDED, ['intake#1 passed', 'spec#1 done']]);
    const messages = [
      'spec.md: noPlaceholders: line 5 still holds the placeholder {{requirements: …}}',
      'spec.md: noPlaceholders: line 9 still holds the placeholder {{tasks: …}}',
      "spec.md: countItems(Tasks, min 1): 'Tasks' has 0 items, fewer than 1",
    ];
    const prompt = readFileSync(join(dir, '01-spec', 'call-1', 'try-2', 'prompt.md'), 'utf8');
    expect(prompt.trimEnd()).toEndWith(messages.join('\n\n'));
    expect(json(dir, '01-spec', 'call-1', 'try-2', 'result.json')).toMatchObject({
      outcome: 'done',
      try: 2,
      derived: { tasks: 2 },
    });
    expect(validateRunDir(dir).issues).toEqual([]);
  });
}, 60_000);

test('a spec without its Requirements section in both tries ends spec#1 in error, naming the check, and the run fails with stage_error, exit 1', async () => {
  await withTempRepo(async (repo) => {
    copyFixture(repo.dir);
    const dropped = (answer: ScriptedAnswer & { outcome: 'done' }): ScriptedAnswer => {
      const spec = answer.files?.['spec.md'] ?? '';
      return { ...answer, files: { 'spec.md': spec.replace(/## Requirements\n[\s\S]*?(?=## Tasks)/, '') } };
    };
    writeHarnessScript(repo.dir, specTries(dropped, dropped));
    const ran = await runCaptured(['FAKE-1'], repo.dir, { env: repo.env });
    const dir = latestRun(repo.dir);
    expect([ran.code, journalOf(dir)]).toEqual([EXIT_FAILED, ['intake#1 passed', 'spec#1 error']]);
    expect(readFileSync(join(dir, 'STATUS'), 'utf8')).toBe('failed stage_error\n');
    expect(json(dir, '01-spec', 'call-1', 'try-2', 'result.json').errors).toEqual([
      {
        reason: 'invalid_output',
        message: "spec.md: hasSections(Requirements, Tasks): has no 'Requirements' section",
      },
    ]);
    expect(validateRunDir(dir).issues).toEqual([]);
  });
}, 60_000);

// publish: describe then open, one stage of two steps, journaled step by step.

const PUBLISHED = [
  'intake#1 passed',
  'spec#1 done',
  'implement#1 done',
  'tests#1 failed',
  'implement#2 done',
  'tests#2 passed',
  'self-review#1 done',
  'publish#1/describe done',
  'publish#1/open passed',
  'publish#1 passed',
];
const PUBLISH = '05-publish/call-1';
const DESCRIBED_TITLE = 'Add a --shout flag to the greet command (FAKE-1)';

test("sail FAKE-1 runs publish as describe, then open, each journaled as it finishes: open's $STAGE_IN holds describe's title and body, its result says where they came from, and the summary lists both steps under publish#1", async () => {
  const ran = await fixtureRun();
  expect([ran.code, journalOf(ran.dir)]).toEqual([EXIT_OK, PUBLISHED]);
  expect(readdirSync(join(ran.dir, PUBLISH, 'steps')).sort()).toEqual(['1-describe', '2-open']);
  expect(readFileSync(join(ran.dir, PUBLISH, 'steps', '2-open', 'in', 'title.txt'), 'utf8')).toBe(DESCRIBED_TITLE);
  expect(json(ran.dir, PUBLISH, 'steps', '2-open', 'result.json').consumed).toEqual({
    title: `${PUBLISH}/steps/1-describe/result.json#/output/title`,
    body: `${PUBLISH}/pr-body.md`,
    ticketKey: 'workflow',
  });
  expect(json(ran.dir, PUBLISH, 'result.json')).toMatchObject({
    key: 'publish#1',
    outcome: 'passed',
    output: PR,
    steps: [
      { step: 'describe', kind: 'agent', outcome: 'done', resultPath: `${PUBLISH}/steps/1-describe/result.json` },
      { step: 'open', kind: 'script', outcome: 'passed', resultPath: `${PUBLISH}/steps/2-open/result.json` },
    ],
  });
  const publish = json(ran.dir, 'summary.json').calls.find((call: { key: string }) => call.key === 'publish#1');
  expect(publish?.steps?.map((step: { key: string }) => step.key)).toEqual(['publish#1/describe', 'publish#1/open']);
  expect(validateRunDir(ran.dir).issues).toEqual([]);
});

test('a run killed as open starts, with describe journaled, resumes and runs only open: each key is journaled once, and describe has one try and one session', async () => {
  await withTempRepo(async (repo) => {
    const sail = copyFixture(repo.dir);
    // The fixture's publish stage, whose open step holds: a fixture that has none has nothing to hold.
    expect(existsSync(join(sail, 'workflows', 'ticket-to-pr', 'stages', 'publish', 'open.sh'))).toBe(true);
    holdBeforeOpen(sail);
    const held = join(repo.home, 'open.pid');
    const child = Bun.spawn([process.execPath, MAIN, 'FAKE-1'], {
      cwd: repo.dir,
      env: { ...repo.env, HOLD_BEFORE_OPEN: held },
      stdin: 'ignore',
      stdout: 'ignore',
      stderr: 'ignore',
    });
    expect(await killWhenHeld(held, child)).toBe(true);
    const dir = latestRun(repo.dir);
    const runId = dir.split('/').at(-1) ?? '';
    expect(journalOf(dir)).toEqual(PUBLISHED.slice(0, 8));
    const resumed = Bun.spawnSync([process.execPath, MAIN, 'resume', runId], { cwd: repo.dir, env: repo.env });
    expect([resumed.exitCode, resumed.stderr.toString(), journalOf(dir)]).toEqual([EXIT_OK, '', PUBLISHED]);
    expect(readdirSync(join(dir, PUBLISH, 'steps', '1-describe')).filter((name) => name.startsWith('try-'))).toEqual(
      [],
    );
    const events = readEvents(dir);
    const describe = (type: SailEvent['type']) =>
      events.filter((event) => event.type === type && 'key' in event && event.key === 'publish#1/describe').length;
    expect([describe('step:start'), describe('harness:session_start')]).toEqual([1, 1]);
  });
}, 60_000);

test('describe scripted blocked ends publish blocked before open starts, and the run fails with the reason the workflow gives', async () => {
  await withTempRepo(async (repo) => {
    const sail = copyFixture(repo.dir);
    const script: HarnessScript = JSON.parse(readFileSync(join(sail, 'fake', 'harness.json'), 'utf8'));
    writeHarnessScript(repo.dir, {
      ...script,
      'publish/describe': [{ outcome: 'blocked', reason: 'the spec and the diff disagree' }],
    });
    const ran = await runCaptured(['FAKE-1'], repo.dir, { env: repo.env });
    const dir = latestRun(repo.dir);
    expect([ran.code, journalOf(dir).slice(-2)]).toEqual([
      EXIT_FAILED,
      ['publish#1/describe blocked', 'publish#1 blocked'],
    ]);
    expect(readFileSync(join(dir, 'STATUS'), 'utf8')).toBe('failed workflow_failed\n');
    const end = readEvents(dir).findLast((event) => event.type === 'run:end');
    expect(end).toMatchObject({ message: 'publish blocked: the spec and the diff disagree' });
    expect(existsSync(join(dir, PUBLISH, 'steps', '2-open'))).toBe(false);
    expect(json(dir, PUBLISH, 'result.json')).toMatchObject({
      outcome: 'blocked',
      reason: 'the spec and the diff disagree',
      output: null,
      steps: [{ step: 'describe', outcome: 'blocked' }],
    });
    expect(validateRunDir(dir).issues).toEqual([]);
  });
}, 60_000);

// runWorkflow() and resumeWorkflow(): a run from its ticket to its end through replay, on the stub ticket-to-pr, and a
// run interrupted or stopped by `until`, then resumed. Each case has a temp repository of its own: one run per .sail/
// in a process, and Bun caches the workflow's modules by path. So a run resumes in a copy of the repository it was
// interrupted in. Every run starts from the stub's `FAKE-1`, so its journal starts with `intake#1`.
import { expect, test } from 'bun:test';
import {
  appendFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { readConfig } from '../../src/engine/config';
import { CONTROL_FILE, requestStop, requestUnwatch } from '../../src/engine/control';
import { type JournalEntry, JournalError, readJournal } from '../../src/engine/journal';
import { readStatus, writeStatus } from '../../src/engine/run-dir';
import { RUN_HEADER_FILE } from '../../src/engine/run-header';
import { type RunEnd, type RunWorkflowOptions, resumeWorkflow, runWorkflow } from '../../src/engine/runtime';
import { formatIssue, validateDocument, validateRunDir } from '../../src/engine/schemas';
import { readEvents } from '../../src/events/consumers/ndjson';
import { rebuildSummary } from '../../src/events/consumers/summary';
import type { Summary } from '../../src/events/summary';
import type { Consumer, ProviderEvent, SailEvent } from '../../src/events/types';
import { fakeAdapters } from '../helpers/adapters';
import {
  AGENT_WORKFLOW,
  entryOf,
  interruptInSession,
  journaled,
  NO_TASKS,
  NO_TASKS_MESSAGE,
  SPEC,
  SPEC_CALL,
  SPEC_CALL_RETURNING_ERRORS,
  SPEC_STAGE,
  sessions,
  specDir,
  specFile,
  specResult,
  submits,
  TICKET,
  usageOf,
  WORKFLOW_FILE,
  writeAgentFixture,
  writeHarnessScript,
} from '../helpers/agent-fixture';
import { GOLDEN_START, GOLDEN_STEP_MS, goldenRandom, type SteppingClock, steppingClock } from '../helpers/clock';
import { copyFixture, edit, write } from '../helpers/fixture';
import { TRIO, TRIO_GROUP, TRIO_KEYS, writeTrio } from '../helpers/review-fixture';
import {
  copyRun,
  interruptWhenAsleep,
  STUB_SPEC_CALL,
  type StubOptions,
  setSleepAt,
  stubExecutions,
  swapImplementAndTests,
  workflowEntries,
  writeStub,
} from '../helpers/stub-workflow';
import { withTempRepo } from '../helpers/temp-repo';

const WORKFLOW = 'workflows/ticket-to-pr/workflow.ts';

/** Runs ticket-to-pr from `cwd` on `FAKE-1`, or as `options` say. It must not be refused. */
async function ran(cwd: string, options: Partial<RunWorkflowOptions> = {}): Promise<RunEnd> {
  const end = await runWorkflow({
    cwd,
    adapters: await fakeAdapters(cwd),
    workflow: 'ticket-to-pr',
    ticket: 'FAKE-1',
    ...options,
  });
  if ('refused' in end) throw new Error(`refused: ${end.refused}`);
  return end;
}

/** The stub's `.sail/`, in a fresh temp repository, changed by `change`, then run to its end. */
async function stubRun(
  options: StubOptions,
  change: (sail: string) => void,
  check: (end: RunEnd, repoDir: string) => void | Promise<void>,
): Promise<void> {
  await withTempRepo(async (repo) => {
    change(writeStub(repo.dir, options));
    await check(await ran(repo.dir), repo.dir);
  });
}

const keys = (runDir: string) => readJournal(runDir).entries.map((entry) => entry.key);
const sha256 = (path: string) => new Bun.CryptoHasher('sha256').update(readFileSync(path)).digest('hex');

/** The runs in `repoDir`'s `.sail-runs/`: every entry but `fake/`, where the fake adapters keep their state. */
const runIds = (repoDir: string): string[] =>
  existsSync(join(repoDir, '.sail-runs'))
    ? readdirSync(join(repoDir, '.sail-runs')).filter((name) => name !== 'fake')
    : [];
/** The only run in `repoDir`'s `.sail-runs/`. */
const onlyRun = (repoDir: string) => join(repoDir, '.sail-runs', runIds(repoDir)[0] ?? '');

test('the stub runs to completion through its fix loop, and every call ran once', async () => {
  await withTempRepo(async (repo) => {
    writeStub(repo.dir);
    const journaled: JournalEntry[] = [];
    let header: string | undefined;
    const end = await ran(repo.dir, {
      onCall: (entry) => {
        journaled.push(entry);
        header ??= sha256(join(onlyRun(repo.dir), 'run.json'));
      },
    });

    expect(end).toMatchObject({
      status: 'completed',
      result: { outcome: 'passed', output: { number: 1, url: 'fake://codehost/stub/pull/1', draft: false }, files: {} },
    });
    expect(end.stopReason).toBeUndefined();
    const { entries } = readJournal(end.dir);
    expect(entries.map((entry) => entry.key)).toEqual([
      'intake#1',
      'spec#1',
      'implement#1',
      'tests#1',
      'implement#2',
      'tests#2',
      'self-review#1',
      'publish#1',
    ]);
    expect(entries.map((entry) => entry.outcome)).toEqual([
      'passed',
      'passed',
      'passed',
      'failed',
      'passed',
      'passed',
      'passed',
      'passed',
    ]);
    expect(journaled).toEqual(entries);
    expect(readStatus(end.dir)).toEqual({ status: 'completed' });
    // Every stage call ran once, as a script. The intake is no script: the engine ran it.
    expect(stubExecutions(repo.dir)).toEqual(keys(end.dir).slice(1));
    expect(validateRunDir(end.dir).issues).toEqual([]);
    const implement = JSON.parse(readFileSync(join(end.dir, '02-implement', 'call-2', 'result.json'), 'utf8'));
    expect(implement.consumed).toEqual({
      spec: '01-spec/call-1/spec.md',
      feedback: '03-tests/call-1/result.json#/output',
    });
    expect(implement.output).toEqual({ notes: 'a stub change', sawFeedback: true });
    expect(sha256(join(end.dir, RUN_HEADER_FILE))).toBe(header ?? '');
  });
});

test('tests that never pass fail the run when the fix loop exceeds its max', async () => {
  await stubRun(
    { testsPassAt: 99 },
    () => undefined,
    (end) => {
      expect(end).toMatchObject({ status: 'failed', stopReason: 'workflow_failed', message: 'loop "fix" exceeded 3' });
      expect(readFileSync(join(end.dir, 'STATUS'), 'utf8')).toBe('failed workflow_failed\n');
      expect(keys(end.dir)).toEqual([
        'intake#1',
        'spec#1',
        'implement#1',
        'tests#1',
        'implement#2',
        'tests#2',
        'implement#3',
        'tests#3',
      ]);
    },
  );
});

const UNMAPPED = 'exit_code: exit code 2 is not mapped to passed or failed';
/** Why the fixture's own ticket-to-pr stops at its spec: the fake harness has no script to answer that session with. */
const FIXTURE_SPEC_FAILED = /^spec#1 ended in error: harness: fake harness: .*\/\.sail\/fake\/harness\.json: ENOENT/;

test('a call that ends in error fails the run with stage_error, and the journal keeps its errors', async () => {
  await stubRun(
    {},
    (sail) => edit(sail, 'stages/tests/run.sh', 'pass_at=2\n', 'exit 2\n'),
    (end) => {
      expect(end).toMatchObject({
        status: 'failed',
        stopReason: 'stage_error',
        message: `tests#1 ended in error: ${UNMAPPED}`,
      });
      expect(readStatus(end.dir)).toEqual({ status: 'failed', stopReason: 'stage_error' });
      const last = readJournal(end.dir).entries.at(-1);
      expect(last).toMatchObject({ key: 'tests#1', outcome: 'error', output: null, reason: UNMAPPED, files: {} });
    },
  );
});

test('a call that asks for its error routes on it', async () => {
  await stubRun(
    {},
    (sail) => {
      edit(sail, 'stages/tests/run.sh', 'pass_at=2\n', 'exit 2\n');
      edit(
        sail,
        WORKFLOW,
        'const t = await run.stage(tests);',
        `const t = await run.stage(tests, {}, { onError: 'return' });\n    if (t.outcome === 'error') return run.fail(\`handled: \${t.reason}\`);`,
      );
    },
    (end) => {
      expect(end).toMatchObject({ status: 'failed', stopReason: 'workflow_failed', message: `handled: ${UNMAPPED}` });
    },
  );
});

test("the fixture's ticket-to-pr, with its harness script gone, gets as far as its spec: the intake leaves the brief spec#1 consumes, and the run fails there, where the fake harness has no script for it", async () => {
  await withTempRepo(async (repo) => {
    rmSync(join(copyFixture(repo.dir), 'fake', 'harness.json'));
    const end = await ran(repo.dir);
    expect(end).toMatchObject({
      status: 'failed',
      stopReason: 'stage_error',
      message: expect.stringMatching(FIXTURE_SPEC_FAILED),
    });
    expect(keys(end.dir)).toEqual(['intake#1', 'spec#1']);
    const spec = JSON.parse(readFileSync(join(end.dir, '01-spec', 'call-1', 'result.json'), 'utf8'));
    expect(spec.consumed).toEqual({ brief: '00-intake/call-1/brief.md' });
  });
});

test('a workflow whose calls change between replays fails with determinism_violation', async () => {
  await stubRun(
    {},
    (sail) => {
      edit(sail, WORKFLOW, 'export default workflow(', 'let replays = 0;\n\nexport default workflow(');
      edit(sail, WORKFLOW, STUB_SPEC_CALL, `  if (replays++ > 0) await run.stage(tests);\n${STUB_SPEC_CALL}`);
    },
    (end) => {
      expect(end).toMatchObject({
        status: 'failed',
        stopReason: 'determinism_violation',
        message: "the workflow asked for 'tests#1' where the journal has 'spec#1'",
      });
      expect(keys(end.dir)).toEqual(['intake#1', 'spec#1']);
    },
  );
});

test('a journal that breaks mid-run is an exception inside sail, and STATUS stays running', async () => {
  await withTempRepo(async (repo) => {
    const sail = writeStub(repo.dir);
    edit(
      sail,
      'workflows/ticket-to-pr/stages/spec/run.sh',
      "printf '# Spec",
      'echo not-json >>"$STAGE_OUT/../../journal.ndjson"\nprintf \'# Spec',
    );
    await expect(ran(repo.dir)).rejects.toThrow(JournalError);
    expect(readStatus(onlyRun(repo.dir))).toEqual({ status: 'running' });
  });
});

test('a second run from the same .sail/ in a process throws before it writes anything', async () => {
  await withTempRepo(async (repo) => {
    writeStub(repo.dir, { testsPassAt: 1 });
    const first = await ran(repo.dir);
    await expect(ran(repo.dir)).rejects.toThrow('already started in this process');
    expect(runIds(repo.dir)).toEqual([first.runId]);
  });
});

test('a refused open passes through, and nothing runs', async () => {
  await withTempRepo(async (repo) => {
    writeStub(repo.dir);
    const adapters = await fakeAdapters(repo.dir);
    expect(await runWorkflow({ cwd: repo.dir, adapters, workflow: 'nope', ticket: 'FAKE-1' })).toEqual({
      refused: expect.stringContaining('no workflow'),
    });
    expect(stubExecutions(repo.dir)).toEqual([]);
  });
});

/** Runs the stub from `repoDir` with `implement#2` asleep, and aborts the run once it sleeps. */
function interruptedIn(repoDir: string, options: Partial<RunWorkflowOptions> = {}) {
  writeStub(repoDir, { sleepAt: 'implement#2' });
  const controller = new AbortController();
  const running = ran(repoDir, { ...options, signal: controller.signal });
  return interruptWhenAsleep(repoDir, running, () => controller.abort());
}

/** The stub's run, interrupted during `implement#2` in a repository of its own, then copied into `to`. Its id. */
function interruptedCopy(to: string, options: Partial<RunWorkflowOptions> = {}): Promise<string> {
  return withTempRepo(async (from) => {
    const { end } = await interruptedIn(from.dir, options);
    copyRun(from.dir, to);
    return end.runId;
  });
}

const STAGE_KEYS = ['spec#1', 'implement#1', 'tests#1', 'implement#2', 'tests#2', 'self-review#1', 'publish#1'];
const ALL_KEYS = ['intake#1', ...STAGE_KEYS];

test('an abort stops the running call, leaves it unjournaled, and suspends the run', async () => {
  await withTempRepo(async (repo) => {
    const journaled: string[] = [];
    const { end, alive } = await interruptedIn(repo.dir, { onCall: (entry) => journaled.push(entry.key) });
    expect(end).toMatchObject({
      status: 'suspended',
      stopReason: 'interrupted',
      message: 'stopped during implement#2',
    });
    expect(alive).toEqual([]);
    expect(readFileSync(join(end.dir, 'STATUS'), 'utf8')).toBe('suspended interrupted\n');
    expect(keys(end.dir)).toEqual(['intake#1', 'spec#1', 'implement#1', 'tests#1']);
    expect(journaled).toEqual(['intake#1', 'spec#1', 'implement#1', 'tests#1']);
    const interrupted = JSON.parse(readFileSync(join(end.dir, '02-implement', 'call-2', 'result.json'), 'utf8'));
    expect(interrupted).toMatchObject({
      key: 'implement#2',
      outcome: 'error',
      errors: [{ reason: 'exit_code', message: expect.stringMatching(/^interrupted, then /) }],
    });
    expect(existsSync(join(end.dir, '02-implement', 'call-2', 'stdout.log'))).toBe(true);
    expect(stubExecutions(repo.dir)).toEqual(['spec#1', 'implement#1', 'tests#1', 'implement#2']);
  });
}, 20_000);

test('an abort seen before the first stage call suspends the run before any stage runs', async () => {
  await withTempRepo(async (repo) => {
    writeStub(repo.dir);
    const controller = new AbortController();
    // Raised once the intake is journaled: the replay that follows asks for spec#1, which never starts.
    const end = await ran(repo.dir, { signal: controller.signal, onCall: () => controller.abort() });
    expect(end).toMatchObject({ status: 'suspended', stopReason: 'interrupted', message: 'stopped before spec#1' });
    expect(readFileSync(join(end.dir, 'STATUS'), 'utf8')).toBe('suspended interrupted\n');
    expect(keys(end.dir)).toEqual(['intake#1']);
    expect(existsSync(join(end.dir, '01-spec'))).toBe(false);
    expect(stubExecutions(repo.dir)).toEqual([]);
  });
});

test("run.input is the intake's output as the journal holds it, in the run that journaled it too: a key JSON drops is gone before the first replay", async () => {
  await withTempRepo(async (repo) => {
    const sail = writeStub(repo.dir, { testsPassAt: 1 });
    edit(
      sail,
      WORKFLOW,
      STUB_SPEC_CALL,
      `  if (run.input.links.some((link) => 'title' in link)) return run.fail('a link holds a title key');\n${STUB_SPEC_CALL}`,
    );
    // A link with a title that is undefined: the key is there in memory, and gone from the journal's line.
    const adapters = await fakeAdapters(repo.dir);
    const { ticketSource } = adapters.ports;
    const get = ticketSource.get.bind(ticketSource);
    ticketSource.get = async (ticketKey) => ({
      ...(await get(ticketKey)),
      links: [{ url: 'https://example.com/spec', title: undefined }],
    });
    const end = await ran(repo.dir, { adapters });
    expect(end).toMatchObject({ status: 'completed' });
    expect(readJournal(end.dir).entries[0]).toMatchObject({
      key: 'intake#1',
      output: { links: [{ url: 'https://example.com/spec' }] },
    });
  });
});

test('a journal that loses its intake mid-run is an exception inside sail: no replay runs on the intake kept in memory, and STATUS stays running', async () => {
  await withTempRepo(async (repo) => {
    writeStub(repo.dir);
    // Emptied as the intake is journaled, before the first replay reads it back.
    const emptied = ran(repo.dir, {
      onCall: (entry) => {
        if (entry.key === 'intake#1') writeFileSync(join(onlyRun(repo.dir), 'journal.ndjson'), '');
      },
    });
    const thrown = await emptied.then(
      () => 'resolved',
      (error: unknown) => error,
    );
    expect(thrown).toBeInstanceOf(JournalError);
    expect(String(thrown)).toEndWith('journal.ndjson:1 is no longer intake#1: the journal changed under the run');
    expect([workflowEntries(repo.dir), stubExecutions(repo.dir)]).toEqual([0, []]);
    expect(readStatus(onlyRun(repo.dir))).toEqual({ status: 'running' });
  });
});

test('an abort does not hide a replay that ends the run', async () => {
  await withTempRepo(async (repo) => {
    const sail = writeStub(repo.dir);
    edit(
      sail,
      WORKFLOW,
      STUB_SPEC_CALL,
      `  if (run.input.ticketKey === 'FAKE-1') return run.fail('no run for FAKE-1');\n${STUB_SPEC_CALL}`,
    );
    const controller = new AbortController();
    // Raised once the intake is journaled, so the abort is there before the one replay starts.
    const end = await ran(repo.dir, { signal: controller.signal, onCall: () => controller.abort() });
    expect(end).toEqual({
      runId: end.runId,
      dir: end.dir,
      status: 'failed',
      stopReason: 'workflow_failed',
      message: 'no run for FAKE-1',
    });
    expect(readStatus(end.dir)).toEqual({ status: 'failed', stopReason: 'workflow_failed' });
  });
});

test("an abort suspends a run whose replay hangs in the workflow's own code", async () => {
  await withTempRepo(async (repo) => {
    const sail = writeStub(repo.dir);
    edit(sail, WORKFLOW, STUB_SPEC_CALL, `  await new Promise<void>(() => {});\n${STUB_SPEC_CALL}`);
    const controller = new AbortController();
    let replaying = false;
    const running = ran(repo.dir, {
      signal: controller.signal,
      onCall: () => {
        replaying = true;
      },
    });
    // The intake is journaled, so the first replay is next: it hangs.
    while (!replaying) await Bun.sleep(10);
    await Bun.sleep(50);
    controller.abort();
    const end = await running;
    expect(end).toMatchObject({ status: 'suspended', stopReason: 'interrupted', message: 'stopped during the replay' });
    expect(readStatus(end.dir)).toEqual({ status: 'suspended', stopReason: 'interrupted' });
    expect(keys(end.dir)).toEqual(['intake#1']);
    expect(stubExecutions(repo.dir)).toEqual([]);
  });
});

test('a resume runs the interrupted call again as its next try, and nothing journaled runs again', async () => {
  await withTempRepo(async (repo) => {
    const runId = await interruptedCopy(repo.dir);
    const dir = join(repo.dir, '.sail-runs', runId);
    const header = sha256(join(dir, RUN_HEADER_FILE));
    const end = await resumeWorkflow({ cwd: repo.dir, adapters: await fakeAdapters(repo.dir), runId });
    expect(end).toMatchObject({ runId, dir, status: 'completed' });
    expect(keys(dir)).toEqual(ALL_KEYS);
    expect(stubExecutions(repo.dir)).toEqual([
      'spec#1',
      'implement#1',
      'tests#1',
      'implement#2',
      'implement#2',
      'tests#2',
      'self-review#1',
      'publish#1',
    ]);
    const retried = readJournal(dir).entries.find((entry) => entry.key === 'implement#2');
    expect(retried?.resultPath).toBe('02-implement/call-2/try-2/result.json');
    const tryTwo = JSON.parse(readFileSync(join(dir, '02-implement', 'call-2', 'try-2', 'result.json'), 'utf8'));
    expect(tryTwo.env.TRY).toBe('2');
    expect(existsSync(join(dir, '02-implement', 'call-2', 'stdout.log'))).toBe(true);
    expect(readStatus(dir)).toEqual({ status: 'completed' });
    expect(validateRunDir(dir).issues).toEqual([]);
    expect(sha256(join(dir, RUN_HEADER_FILE))).toBe(header);
  });
}, 30_000);

test('a workflow whose keys no longer fit the journal fails the resume with determinism_violation, and nothing runs', async () => {
  await withTempRepo(async (repo) => {
    const runId = await interruptedCopy(repo.dir);
    swapImplementAndTests(join(repo.dir, '.sail'));
    const end = await resumeWorkflow({ cwd: repo.dir, adapters: await fakeAdapters(repo.dir), runId });
    expect(end).toMatchObject({
      runId,
      status: 'failed',
      stopReason: 'determinism_violation',
      message: "the workflow asked for 'tests#1' where the journal has 'implement#1'",
    });
    expect(stubExecutions(repo.dir)).toEqual(['spec#1', 'implement#1', 'tests#1', 'implement#2']);
    const dir = join(repo.dir, '.sail-runs', runId);
    expect(readStatus(dir)).toEqual({ status: 'failed', stopReason: 'determinism_violation' });
  });
}, 30_000);

test('a run left running, as after a crash, resumes', async () => {
  await withTempRepo(async (repo) => {
    const runId = await interruptedCopy(repo.dir);
    const dir = join(repo.dir, '.sail-runs', runId);
    writeFileSync(join(dir, 'STATUS'), 'running\n');
    const end = await resumeWorkflow({ cwd: repo.dir, adapters: await fakeAdapters(repo.dir), runId });
    expect(end).toMatchObject({ runId, status: 'completed' });
    expect(keys(dir)).toEqual(ALL_KEYS);
  });
}, 30_000);

test('a refused resume passes through, and neither STATUS nor the journal changes', async () => {
  await withTempRepo(async (repo) => {
    const runId = await withTempRepo(async (from) => {
      writeStub(from.dir, { testsPassAt: 1 });
      const { runId } = await ran(from.dir);
      copyRun(from.dir, repo.dir);
      return runId;
    });
    const dir = join(repo.dir, '.sail-runs', runId);
    const before = [readFileSync(join(dir, 'STATUS'), 'utf8'), readFileSync(join(dir, 'journal.ndjson'), 'utf8')];
    const ranBefore = stubExecutions(repo.dir);
    expect(await resumeWorkflow({ cwd: repo.dir, adapters: await fakeAdapters(repo.dir), runId })).toEqual({
      refused: `run ${runId} has completed: there is nothing to resume`,
    });
    expect([readFileSync(join(dir, 'STATUS'), 'utf8'), readFileSync(join(dir, 'journal.ndjson'), 'utf8')]).toEqual(
      before,
    );
    expect(stubExecutions(repo.dir)).toEqual(ranBefore);
  });
});

test('resuming from a .sail/ this process already ran from throws before it writes anything', async () => {
  await withTempRepo(async (repo) => {
    const { end } = await interruptedIn(repo.dir);
    const status = readFileSync(join(end.dir, 'STATUS'), 'utf8');
    await expect(
      resumeWorkflow({ cwd: repo.dir, adapters: await fakeAdapters(repo.dir), runId: end.runId }),
    ).rejects.toThrow('already started in this process');
    expect(readFileSync(join(end.dir, 'STATUS'), 'utf8')).toBe(status);
  });
}, 20_000);

/** The run's `events.ndjson`, or '' when it has none. */
const eventsText = (runDir: string): string =>
  existsSync(join(runDir, 'events.ndjson')) ? readFileSync(join(runDir, 'events.ndjson'), 'utf8') : '';

/** The run's events, parsed. */
const events = (runDir: string): SailEvent[] =>
  eventsText(runDir)
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line));

/** `<type> <key>`, or `<type> <at>→<took>` for a route, per event: a stream at a glance. */
const outline = (list: readonly SailEvent[]): string[] =>
  list.map((event) => {
    if (event.type === 'workflow:route') return `${event.type} ${event.at}→${event.took}`;
    return 'key' in event && event.key !== undefined ? `${event.type} ${event.key}` : event.type;
  });

/** One of the stub's calls, from its start to its journal line: a script with `bindings` bound and `files` produced. */
const callOutline = (key: string, bindings: number, files: number): string[] => [
  `stage:start ${key}`,
  ...Array<string>(bindings).fill(`input:materialised ${key}`),
  `script:exec ${key}`,
  `script:exit ${key}`,
  `output:validated ${key}`,
  ...Array<string>(files).fill(`file:produced ${key}`),
  `stage:end ${key}`,
  `journal:append ${key}`,
];
const route = (at: string, took: string) => `workflow:route ${at}→${took}`;

/**
 * How every run's stream opens: its start, its lease and workspace, what the claim did to the ticket, then the intake,
 * to its journal line.
 */
const OPENING = [
  'run:start',
  'workspace:leased',
  'workspace:created',
  'ticket:claimed',
  'ticket:commented',
  'intake:start intake#1',
  'ticket:fetched intake#1',
  'output:validated intake#1',
  'file:produced intake#1',
  'file:produced intake#1',
  'intake:end intake#1',
  'journal:append intake#1',
];

/** The stub's whole stream, tests passing on their second call. No route leaves the intake. */
const STUB_OUTLINE = [
  ...OPENING,
  ...callOutline('spec#1', 1, 1),
  'loop:iteration',
  route('spec#1', 'implement#1'),
  ...callOutline('implement#1', 1, 1),
  route('implement#1', 'tests#1'),
  ...callOutline('tests#1', 0, 1),
  'loop:iteration',
  route('tests#1', 'implement#2'),
  ...callOutline('implement#2', 2, 1),
  route('implement#2', 'tests#2'),
  ...callOutline('tests#2', 0, 1),
  route('tests#2', 'self-review#1'),
  ...callOutline('self-review#1', 1, 0),
  'loop:exit',
  route('self-review#1', 'publish#1'),
  ...callOutline('publish#1', 1, 0),
  route('publish#1', 'end'),
  'workspace:released',
  'workspace:lease_released',
  'run:end',
];

const seqs = (list: readonly SailEvent[]) => list.map((event) => event.seq);
const gapless = (list: readonly SailEvent[]) => list.map((_, i) => i + 1);

test("the stub's run writes its whole event stream to events.ndjson, numbered from 1: its start, what the claim did, the intake, then every call", async () => {
  await withTempRepo(async (repo) => {
    writeStub(repo.dir);
    const end = await ran(repo.dir);
    const list = events(end.dir);

    expect(outline(list)).toEqual(STUB_OUTLINE);
    expect(seqs(list)).toEqual(gapless(list));
    expect(list.flatMap((event) => validateDocument('sail.event.v1', event)).map(formatIssue)).toEqual([]);

    const header = JSON.parse(readFileSync(join(end.dir, RUN_HEADER_FILE), 'utf8'));
    expect(list[0]).toEqual({
      seq: 1,
      ts: expect.any(String),
      type: 'run:start',
      runId: end.runId,
      source: header.source,
      workflow: header.workflow,
      roster: { intake: header.intake, stages: header.stages },
      adapters: header.adapters,
      budget: header.budget,
    });
    expect(header.source).toEqual({ kind: 'ticket', ticketKey: 'FAKE-1', via: 'cli', forced: [] });
    // What the claim did, as the engine reports it: neither event belongs to a call, so neither has a key.
    const reported = { ts: expect.any(String), runId: end.runId, ticketKey: 'FAKE-1' };
    expect(list.slice(3, 5)).toEqual([
      { seq: 4, ...reported, type: 'ticket:claimed', state: { type: 'started', name: 'In Progress' } },
      { seq: 5, ...reported, type: 'ticket:commented', body: `sail run ${end.runId} started` },
    ]);
    expect(list.at(-1)).toEqual({
      seq: list.length,
      ts: expect.any(String),
      type: 'run:end',
      runId: end.runId,
      status: 'completed',
      result: end.result,
      replays: 8,
    });
    expect(list.filter((event) => event.type === 'journal:append')).toMatchObject(
      readJournal(end.dir).entries.map((entry) => ({ key: entry.key, line: entry.seq, outcome: entry.outcome })),
    );
    expect(list.filter((event) => event.type === 'loop:iteration' || event.type === 'loop:exit')).toMatchObject([
      { type: 'loop:iteration', loop: 'fix', iteration: 1, max: 3 },
      {
        type: 'loop:iteration',
        loop: 'fix',
        iteration: 2,
        max: 3,
        feedback: { from: '03-tests/call-1/result.json#/output' },
      },
      { type: 'loop:exit', loop: 'fix', iterations: 2, max: 3, reason: 'break' },
    ]);
    expect(
      list.filter((event) => event.type === 'workflow:route').map((event) => ('value' in event ? event.value : null)),
    ).toEqual(['passed', 'passed', 'failed', 'passed', 'passed', 'passed', 'passed']);
    expect(validateRunDir(end.dir).issues).toEqual([]);
  });
});

test('a run whose loop exceeds its max ends its stream with loop:exit exceeded, then run:end failed', async () => {
  await stubRun(
    { testsPassAt: 99 },
    () => undefined,
    (end) => {
      const list = events(end.dir);
      expect(outline(list.slice(-5))).toEqual([
        'journal:append tests#3',
        'loop:exit',
        'workspace:released',
        'workspace:lease_released',
        'run:end',
      ]);
      expect([list.at(-4), list.at(-1)]).toMatchObject([
        { type: 'loop:exit', loop: 'fix', iterations: 3, max: 3, reason: 'exceeded' },
        {
          type: 'run:end',
          status: 'failed',
          stopReason: 'workflow_failed',
          message: 'loop "fix" exceeded 3',
          replays: 8,
        },
      ]);
      expect(list.at(-1)).not.toHaveProperty('result');
    },
  );
});

test("a resume appends to the interrupted run's events, continuing seq with no marker", async () => {
  await withTempRepo(async (repo) => {
    const runId = await interruptedCopy(repo.dir);
    const dir = join(repo.dir, '.sail-runs', runId);
    const before = eventsText(dir);
    const interrupted = events(dir);
    expect(interrupted.at(-1)).toMatchObject({
      type: 'run:end',
      status: 'suspended',
      stopReason: 'interrupted',
      message: 'stopped during implement#2',
    });

    expect(await resumeWorkflow({ cwd: repo.dir, adapters: await fakeAdapters(repo.dir), runId })).toMatchObject({
      status: 'completed',
    });
    expect(eventsText(dir).startsWith(before)).toBe(true);
    const list = events(dir);
    expect(seqs(list)).toEqual(gapless(list));
    const resumed = list.slice(interrupted.length);
    expect(outline(resumed.slice(0, 4))).toEqual([
      'workspace:leased',
      'loop:iteration',
      'workflow:route tests#1→implement#2',
      'stage:start implement#2',
    ]);
    expect(resumed[3]).toMatchObject({ try: 2 });
    expect(outline(resumed).filter((line) => line.startsWith('run:start'))).toEqual([]);
    expect(resumed.at(-1)).toMatchObject({ type: 'run:end', status: 'completed', replays: 5 });
    expect(validateRunDir(dir).issues).toEqual([]);
  });
}, 30_000);

test("a forced run of a ticket that is not unstarted reports the move in the claim's place: ticket:updated, then ticket:commented, and run:start lists the state check as overridden", async () => {
  await withTempRepo(async (repo) => {
    writeStub(repo.dir, { testsPassAt: 1 });
    const end = await ran(repo.dir, { ticket: 'FAKE-4', force: true });
    expect([end.status, end.runId.slice(0, 7)]).toEqual(['completed', 'FAKE-4-']);
    const list = events(end.dir);
    expect(outline(list.slice(0, 6))).toEqual([
      'run:start',
      'workspace:leased',
      'workspace:created',
      'ticket:updated',
      'ticket:commented',
      'intake:start intake#1',
    ]);
    const reported = { ts: expect.any(String), runId: end.runId, ticketKey: 'FAKE-4' };
    const inProgress = { type: 'started', name: 'In Progress' } as const;
    expect(list.slice(3, 5)).toEqual([
      { seq: 4, ...reported, type: 'ticket:updated', change: { state: 'in-progress' }, state: inProgress },
      { seq: 5, ...reported, type: 'ticket:commented', body: `sail run ${end.runId} started` },
    ]);
    expect(list[0]).toMatchObject({ source: { kind: 'ticket', ticketKey: 'FAKE-4', via: 'cli', forced: ['state'] } });
    expect(outline(list)).not.toContain('ticket:claimed');
    expect(seqs(list)).toEqual(gapless(list));
    expect(validateRunDir(end.dir).issues).toEqual([]);
  });
});

test('a resume reports nothing of the claim again: across both processes the stream holds it once', async () => {
  await withTempRepo(async (repo) => {
    const runId = await interruptedCopy(repo.dir);
    const dir = join(repo.dir, '.sail-runs', runId);
    expect(await resumeWorkflow({ cwd: repo.dir, adapters: await fakeAdapters(repo.dir), runId })).toMatchObject({
      status: 'completed',
    });
    const ticket = outline(events(dir)).filter((line) => line.startsWith('ticket:'));
    expect(ticket).toEqual(['ticket:claimed', 'ticket:commented', 'ticket:fetched intake#1']);
    expect(validateRunDir(dir).issues).toEqual([]);
  });
}, 30_000);

test('a torn tail is cut before a resume, and seq continues from the last complete line', async () => {
  await withTempRepo(async (repo) => {
    const runId = await interruptedCopy(repo.dir);
    const dir = join(repo.dir, '.sail-runs', runId);
    const before = eventsText(dir);
    const torn = '{"seq":99,"ts":"2026-09-28T';
    appendFileSync(join(dir, 'events.ndjson'), torn);

    expect(await resumeWorkflow({ cwd: repo.dir, adapters: await fakeAdapters(repo.dir), runId })).toMatchObject({
      status: 'completed',
    });
    const after = eventsText(dir);
    expect(after).not.toContain(torn);
    expect(after.startsWith(before)).toBe(true);
    const list = events(dir);
    expect(seqs(list)).toEqual(gapless(list));
    expect(validateRunDir(dir).issues).toEqual([]);
  });
}, 30_000);

test("an events file whose last line can't be read refuses the resume, and leaves STATUS as it was", async () => {
  await withTempRepo(async (repo) => {
    const runId = await interruptedCopy(repo.dir);
    const dir = join(repo.dir, '.sail-runs', runId);
    const line = events(dir).length + 1;
    appendFileSync(join(dir, 'events.ndjson'), 'not json\n');
    const ranBefore = stubExecutions(repo.dir);

    expect(await resumeWorkflow({ cwd: repo.dir, adapters: await fakeAdapters(repo.dir), runId })).toEqual({
      refused: expect.stringMatching(
        new RegExp(`^events\\.ndjson:${line} can't be read, so the events can't continue: `),
      ),
    });
    expect(readFileSync(join(dir, 'STATUS'), 'utf8')).toBe('suspended interrupted\n');
    expect(stubExecutions(repo.dir)).toEqual(ranBefore);
  });
}, 30_000);

test('a consumer that throws is reported after each event it failed on, and the run completes', async () => {
  await withTempRepo(async (repo) => {
    writeStub(repo.dir);
    const flaky: Consumer = {
      name: 'flaky',
      onEvent(event) {
        if (event.type === 'stage:start') throw new Error('boom');
      },
    };
    const end = await ran(repo.dir, { consumers: [flaky] });
    expect(end.status).toBe('completed');
    const list = events(end.dir);
    const starts = list.filter((event) => event.type === 'stage:start');
    expect(starts).toHaveLength(7);
    for (const start of starts) {
      expect(list[start.seq]).toEqual({
        seq: start.seq + 1,
        ts: expect.any(String),
        type: 'error:consumer',
        runId: end.runId,
        consumer: 'flaky',
        failed: { seq: start.seq, type: 'stage:start' },
        message: 'boom',
      });
    }
    expect(outline(list.filter((event) => event.type !== 'error:consumer'))).toEqual(STUB_OUTLINE);
    expect(seqs(list)).toEqual(gapless(list));
  });
});

test('an exception inside sail leaves error:crash as the last event, and still propagates', async () => {
  await withTempRepo(async (repo) => {
    const sail = writeStub(repo.dir);
    edit(
      sail,
      'workflows/ticket-to-pr/stages/spec/run.sh',
      "printf '# Spec",
      'echo not-json >>"$STAGE_OUT/../../journal.ndjson"\nprintf \'# Spec',
    );
    const error = await ran(repo.dir).catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(JournalError);
    const [runId = ''] = runIds(repo.dir);
    const dir = join(repo.dir, '.sail-runs', runId);
    // The journal breaks while spec#1 is being journaled, so the crash names that call.
    expect(events(dir).at(-1)).toEqual({
      seq: expect.any(Number),
      ts: expect.any(String),
      type: 'error:crash',
      runId,
      key: 'spec#1',
      message: (error as Error).message,
    });
    expect(readStatus(dir)).toEqual({ status: 'running' });
  });
});

test('a replay abandoned by an abort reports nothing after run:end, even once its workflow moves on', async () => {
  await withTempRepo(async (repo) => {
    const sail = writeStub(repo.dir);
    const moved = join(repo.dir, 'moved');
    edit(
      sail,
      WORKFLOW,
      "  if (s.outcome === 'failed') return run.fail('spec failed');",
      `  if (s.outcome === 'failed') return run.fail('spec failed');
  await new Promise((resolve) => setTimeout(resolve, 100));
  (await import('node:fs')).writeFileSync(${JSON.stringify(moved)}, '');`,
    );
    const controller = new AbortController();
    const end = await ran(repo.dir, {
      signal: controller.signal,
      onCall: (entry) => {
        if (entry.key === 'spec#1') controller.abort();
      },
    });
    expect(end).toMatchObject({ status: 'suspended', message: 'stopped during the replay' });
    while (!existsSync(moved)) await Bun.sleep(10);
    expect(outline(events(end.dir)).slice(-2)).toEqual(['journal:append spec#1', 'run:end']);
  });
});

test("a result JSON can't hold is left out of run:end, which says why, and the stream keeps its end", async () => {
  await withTempRepo(async (repo) => {
    const sail = writeStub(repo.dir, { testsPassAt: 1 });
    edit(
      sail,
      WORKFLOW,
      "  return run.stage(publish, { spec: s.files['spec.md'] });",
      "  await run.stage(publish, { spec: s.files['spec.md'] });\n  return { count: 1n };",
    );
    const end = await ran(repo.dir);
    expect(end).toMatchObject({ status: 'completed', result: { count: 1n } });
    const list = events(end.dir);
    expect(list.at(-1)).toEqual({
      seq: list.length,
      ts: expect.any(String),
      type: 'run:end',
      runId: end.runId,
      status: 'completed',
      message: expect.stringMatching(/^the workflow's result can't be written as JSON: ./),
      replays: expect.any(Number),
    });
    expect(seqs(list)).toEqual(gapless(list));
    expect(outline(list)).not.toContain('error:consumer');
    expect(validateRunDir(end.dir).issues).toEqual([]);
  });
});

test('run:end holds the result as it was serialised once, so a toJSON that throws the second time changes nothing', async () => {
  await withTempRepo(async (repo) => {
    const sail = writeStub(repo.dir, { testsPassAt: 1 });
    edit(
      sail,
      WORKFLOW,
      "  return run.stage(publish, { spec: s.files['spec.md'] });",
      `  await run.stage(publish, { spec: s.files['spec.md'] });
  let calls = 0;
  return {
    toJSON: () => {
      if (++calls > 1) throw new Error('serialised twice');
      return { ok: true };
    },
  };`,
    );
    const end = await ran(repo.dir);
    const list = events(end.dir);
    expect(list.at(-1)).toMatchObject({ seq: list.length, type: 'run:end', status: 'completed', result: { ok: true } });
    expect(seqs(list)).toEqual(gapless(list));
    expect(outline(list)).not.toContain('error:consumer');
  });
});

test('consumers passed in receive the events the file holds, in the same order', async () => {
  await withTempRepo(async (repo) => {
    writeStub(repo.dir, { testsPassAt: 1 });
    const seen: SailEvent[] = [];
    const end = await ran(repo.dir, { consumers: [{ name: 'mirror', onEvent: (event) => seen.push(event) }] });
    expect(outline([seen[0], seen.at(-1)].filter((event) => event !== undefined))).toEqual(['run:start', 'run:end']);
    expect(JSON.parse(JSON.stringify(seen))).toEqual(events(end.dir));
  });
});

/** The run's summary.json as written, or '' when it has none. */
const summaryText = (runDir: string): string =>
  existsSync(join(runDir, 'summary.json')) ? readFileSync(join(runDir, 'summary.json'), 'utf8') : '';

/** The run's summary, or undefined when it has none. */
const summaryOf = (runDir: string): Summary | undefined => {
  const text = summaryText(runDir);
  return text === '' ? undefined : JSON.parse(text);
};

/** The stub's routes, one per move after a journaled stage call, tests passing on their second call. */
const STUB_ROUTES = [
  { at: 'spec#1', value: 'passed', took: 'implement#1' },
  { at: 'implement#1', value: 'passed', took: 'tests#1' },
  { at: 'tests#1', value: 'failed', took: 'implement#2' },
  { at: 'implement#2', value: 'passed', took: 'tests#2' },
  { at: 'tests#2', value: 'passed', took: 'self-review#1' },
  { at: 'self-review#1', value: 'passed', took: 'publish#1' },
  { at: 'publish#1', value: 'passed', took: 'end' },
];

test("the stub's summary.json is rewritten after every call, and ends completed with its loops and routes", async () => {
  await withTempRepo(async (repo) => {
    writeStub(repo.dir);
    const listed: number[] = [];
    const issues: string[] = [];
    const end = await ran(repo.dir, {
      onCall: () => {
        const summary = summaryOf(onlyRun(repo.dir));
        issues.push(...validateDocument('sail.summary.v1', summary).map(formatIssue));
        listed.push(summary?.calls.length ?? 0);
      },
    });

    expect(readdirSync(end.dir).sort()).toEqual([
      '00-intake',
      '01-spec',
      '02-implement',
      '03-tests',
      '04-self-review',
      '05-publish',
      'STATUS',
      'events.ndjson',
      'journal.ndjson',
      'run.json',
      'summary.json',
    ]);
    expect([listed, issues]).toEqual([[1, 2, 3, 4, 5, 6, 7, 8], []]);
    const text = summaryText(end.dir);
    const summary = JSON.parse(text);
    expect(text).toBe(`${JSON.stringify(summary, null, 2)}\n`);
    expect(summary).toMatchObject({
      status: 'completed',
      loops: { fix: { iterations: 2, max: 3 } },
      totals: { replays: 8 },
    });
    expect(summary.calls.map((call: { key: string }) => call.key)).toEqual(ALL_KEYS);
    expect(summary.routes).toEqual(STUB_ROUTES);
    expect(validateRunDir(end.dir).issues).toEqual([]);
  });
});

test("rebuilding the stub's summary.json from its events writes the file the run wrote, byte for byte", async () => {
  await withTempRepo(async (repo) => {
    writeStub(repo.dir, { testsPassAt: 1 });
    const end = await ran(repo.dir);
    const written = summaryText(end.dir);
    const path = join(end.dir, 'summary.json');
    rmSync(path, { force: true });
    const rebuilt = rebuildSummary(end.dir);
    expect([rebuilt, summaryText(end.dir)]).toEqual([{ summary: JSON.parse(written || 'null'), path }, written]);
  });
});

test("after an interrupt and a resume, summary.json is completed with the retried call's latest try, one route into it and both processes' replays", async () => {
  await withTempRepo(async (repo) => {
    const runId = await interruptedCopy(repo.dir);
    const dir = join(repo.dir, '.sail-runs', runId);
    const interrupted = summaryOf(dir);
    expect([interrupted?.status, interrupted?.stopReason, interrupted?.calls.map((call) => call.key)]).toEqual([
      'suspended',
      'interrupted',
      ['intake#1', 'spec#1', 'implement#1', 'tests#1', 'implement#2'],
    ]);

    expect(await resumeWorkflow({ cwd: repo.dir, adapters: await fakeAdapters(repo.dir), runId })).toMatchObject({
      status: 'completed',
    });
    const written = summaryText(dir);
    const summary = summaryOf(dir);
    const replays = events(dir).reduce((sum, event) => sum + (event.type === 'run:end' ? event.replays : 0), 0);
    expect([summary?.status, summary?.totals.replays, summary?.calls.map((call) => call.key)]).toEqual([
      'completed',
      replays,
      ALL_KEYS,
    ]);
    expect(summary?.calls.find((call) => call.key === 'implement#2')).toMatchObject({
      key: 'implement#2',
      outcome: 'passed',
      resultPath: '02-implement/call-2/try-2/result.json',
    });
    expect(summary?.routes?.filter((move) => move.at === 'tests#1')).toEqual([
      { at: 'tests#1', value: 'failed', took: 'implement#2' },
    ]);

    rmSync(join(dir, 'summary.json'));
    expect(rebuildSummary(dir)).toEqual({ summary: summary as Summary, path: join(dir, 'summary.json') });
    expect(summaryText(dir)).toBe(written);
  });
}, 30_000);

test("a summary.json that can't be written is reported at each write point after, and the run completes", async () => {
  await withTempRepo(async (repo) => {
    writeStub(repo.dir);
    let blocked = false;
    const end = await ran(repo.dir, {
      onCall: () => {
        if (blocked) return;
        blocked = true;
        const dir = onlyRun(repo.dir);
        rmSync(join(dir, 'summary.json'), { force: true });
        mkdirSync(join(dir, 'summary.json'));
      },
    });
    expect(end.status).toBe('completed');
    const list = events(end.dir);
    const failures = list.flatMap((event) =>
      event.type === 'error:consumer' ? [[event.consumer, event.failed.type]] : [],
    );
    // Blocked as the intake is journaled: every stage call's journal line fails to be summarised, and so does the end.
    expect(failures).toEqual([
      ...Array<string[]>(7).fill(['summary.json', 'journal:append']),
      ['summary.json', 'run:end'],
    ]);
    expect(outline(list.filter((event) => event.type !== 'error:consumer'))).toEqual(STUB_OUTLINE);
  });
});

test('a crash leaves summary.json running, with the calls made before it', async () => {
  await withTempRepo(async (repo) => {
    const sail = writeStub(repo.dir);
    edit(
      sail,
      'workflows/ticket-to-pr/stages/spec/run.sh',
      "printf '# Spec",
      'echo not-json >>"$STAGE_OUT/../../journal.ndjson"\nprintf \'# Spec',
    );
    await expect(ran(repo.dir)).rejects.toThrow(JournalError);
    const summary = summaryOf(onlyRun(repo.dir));
    expect([summary?.status, summary?.calls.map((call) => call.key)]).toEqual(['running', ['intake#1', 'spec#1']]);
  });
});

// `until` (D10): the run stops, suspended, once the named stage's first call is journaled and the workflow asks for
// another call. A replay that ends the run ends it.

const UNTIL_SPEC = {
  status: 'suspended',
  stopReason: 'until',
  message: 'stopped after spec#1, as --until asked',
} as const;

/** The stub's run from `FAKE-1`, stopped by `until: 'spec'` in a repository of its own, then copied into `to`. Its id. */
function stoppedCopy(to: string): Promise<string> {
  return withTempRepo(async (from) => {
    writeStub(from.dir);
    const end = await ran(from.dir, { until: 'spec' });
    copyRun(from.dir, to);
    return end.runId;
  });
}

test("until stops the run after the named stage's first call: suspended with until, that call the last journaled and the only one that ran, and the stream and the summary say so", async () => {
  await withTempRepo(async (repo) => {
    writeStub(repo.dir);
    const end = await ran(repo.dir, { until: 'spec' });
    expect(end).toEqual({ runId: end.runId, dir: end.dir, ...UNTIL_SPEC });
    expect(readFileSync(join(end.dir, 'STATUS'), 'utf8')).toBe('suspended until\n');
    expect([keys(end.dir), stubExecutions(repo.dir)]).toEqual([['intake#1', 'spec#1'], ['spec#1']]);
    const list = events(end.dir);
    expect(list.at(-1)).toEqual({
      seq: list.length,
      ts: expect.any(String),
      type: 'run:end',
      runId: end.runId,
      ...UNTIL_SPEC,
      replays: 2,
    });
    const summary = summaryOf(end.dir);
    expect([summary?.status, summary?.stopReason, summary?.calls.map((call) => call.key)]).toEqual([
      'suspended',
      'until',
      ['intake#1', 'spec#1'],
    ]);
    expect(validateRunDir(end.dir).issues).toEqual([]);
  });
});

test('a resume takes a run until stopped to its end: every call ran once, and the summary holds each route once, the one out of the stage it stopped after included', async () => {
  await withTempRepo(async (repo) => {
    const runId = await stoppedCopy(repo.dir);
    const dir = join(repo.dir, '.sail-runs', runId);
    const end = await resumeWorkflow({ cwd: repo.dir, adapters: await fakeAdapters(repo.dir), runId });
    expect(end).toMatchObject({ runId, status: 'completed' });
    expect([keys(dir), stubExecutions(repo.dir)]).toEqual([ALL_KEYS, STAGE_KEYS]);
    const summary = summaryOf(dir);
    expect([summary?.status, summary?.routes]).toEqual(['completed', STUB_ROUTES]);
    expect(readStatus(dir)).toEqual({ status: 'completed' });
    expect(validateRunDir(dir).issues).toEqual([]);
  });
});

test("until stops after the named stage's first call whatever its outcome: a failed tests#1 is journaled, and the pass it would send back to implement never starts", async () => {
  await withTempRepo(async (repo) => {
    writeStub(repo.dir);
    const end = await ran(repo.dir, { until: 'tests' });
    expect(end).toMatchObject({
      status: 'suspended',
      stopReason: 'until',
      message: 'stopped after tests#1, as --until asked',
    });
    expect(readJournal(end.dir).entries.at(-1)).toMatchObject({ key: 'tests#1', outcome: 'failed' });
    expect(stubExecutions(repo.dir)).toEqual(['spec#1', 'implement#1', 'tests#1']);
  });
});

test('until naming the stage of the last call completes the run: a replay that ends the run ends it', async () => {
  await withTempRepo(async (repo) => {
    writeStub(repo.dir, { testsPassAt: 1 });
    const stopped = await withTempRepo(async (other) => {
      writeStub(other.dir, { testsPassAt: 1 });
      return (await ran(other.dir, { until: 'self-review' })).stopReason;
    });
    const end = await ran(repo.dir, { until: 'publish' });
    expect([stopped, end.status, end.stopReason, keys(end.dir).at(-1)]).toEqual([
      'until',
      'completed',
      undefined,
      'publish#1',
    ]);
    expect(readStatus(end.dir)).toEqual({ status: 'completed' });
  });
});

test("a named stage whose first call ends in error fails the run with stage_error: until doesn't suspend a run that can only fail", async () => {
  await withTempRepo(async (repo) => {
    const failing = await withTempRepo(async (other) => {
      writeStub(other.dir);
      return (await ran(other.dir, { until: 'tests' })).stopReason;
    });
    edit(writeStub(repo.dir), 'stages/tests/run.sh', 'pass_at=2\n', 'exit 2\n');
    const end = await ran(repo.dir, { until: 'tests' });
    expect([failing, end.status, end.stopReason, end.message]).toEqual([
      'until',
      'failed',
      'stage_error',
      `tests#1 ended in error: ${UNMAPPED}`,
    ]);
  });
});

test('an abort raised while the named stage runs still suspends the run with interrupted, and leaves the call unjournaled', async () => {
  await withTempRepo(async (repo) => {
    writeStub(repo.dir, { sleepAt: 'spec#1' });
    const controller = new AbortController();
    const running = ran(repo.dir, { until: 'spec', signal: controller.signal });
    const { end } = await interruptWhenAsleep(repo.dir, running, () => controller.abort());
    expect(end).toMatchObject({ status: 'suspended', stopReason: 'interrupted', message: 'stopped during spec#1' });
    expect(keys(end.dir)).toEqual(['intake#1']);
  });
}, 20_000);

test('an abort seen together with the stop loses: once the named call is journaled the run is suspended with until', async () => {
  await withTempRepo(async (repo) => {
    writeStub(repo.dir);
    const controller = new AbortController();
    const end = await ran(repo.dir, {
      until: 'spec',
      signal: controller.signal,
      onCall: (entry) => {
        if (entry.key === 'spec#1') controller.abort();
      },
    });
    expect(end).toEqual({ runId: end.runId, dir: end.dir, ...UNTIL_SPEC });
    expect(readStatus(end.dir)).toEqual({ status: 'suspended', stopReason: 'until' });
  });
});

// The control file (DECISIONS D2): taken before the intake and before each call, written here as the call before it
// is journaled, or as the run starts.

/** The lease files the fake workspace keeps under `.sail-runs/fake/leases/`. */
const leaseFiles = (repoDir: string): string[] => {
  const dir = join(repoDir, '.sail-runs', 'fake', 'leases');
  return existsSync(dir) ? readdirSync(dir).filter((name) => name.endsWith('.json')) : [];
};

test('a CONTROL that says unwatched before a call suspends the run with unwatched: the call never runs, its workspace and lease stay, and a resume completes it without running a journaled call again', async () => {
  await withTempRepo(async (repo) => {
    writeStub(repo.dir, { testsPassAt: 1 });
    const end = await ran(repo.dir, {
      onCall: (entry) => {
        if (entry.key === 'implement#1') requestUnwatch(onlyRun(repo.dir));
      },
    });
    expect(end).toMatchObject({
      status: 'suspended',
      stopReason: 'unwatched',
      message: 'its workflow was unwatched: stopped before tests#1',
    });
    const last = events(end.dir).at(-1);
    expect({
      status: readFileSync(join(end.dir, 'STATUS'), 'utf8'),
      journaled: keys(end.dir),
      ran: stubExecutions(repo.dir),
      end: [last?.type, last?.type === 'run:end' ? last.stopReason : undefined],
      workspace: existsSync(join(end.dir, 'workspace')),
      leases: leaseFiles(repo.dir).length,
      control: existsSync(join(end.dir, CONTROL_FILE)),
      summary: summaryOf(end.dir)?.stopReason,
      issues: validateRunDir(end.dir).issues,
    }).toEqual({
      status: 'suspended unwatched\n',
      journaled: ['intake#1', 'spec#1', 'implement#1'],
      ran: ['spec#1', 'implement#1'],
      end: ['run:end', 'unwatched'],
      workspace: true,
      leases: 1,
      control: false,
      summary: 'unwatched',
      issues: [],
    });
    await withTempRepo(async (copy) => {
      copyRun(repo.dir, copy.dir);
      const resumed = await resumeWorkflow({ cwd: copy.dir, adapters: await fakeAdapters(copy.dir), runId: end.runId });
      expect([resumed, stubExecutions(copy.dir)]).toMatchObject([
        { status: 'completed' },
        ['spec#1', 'implement#1', 'tests#1', 'self-review#1', 'publish#1'],
      ]);
    });
  });
}, 30_000);

test('a CONTROL that says stopped before a call fails the run with stopped, releasing its workspace and lease, and a resume is refused as final', async () => {
  await withTempRepo(async (repo) => {
    writeStub(repo.dir);
    const end = await ran(repo.dir, {
      onCall: (entry) => {
        if (entry.key === 'spec#1') requestStop(onlyRun(repo.dir));
      },
    });
    expect(end).toMatchObject({
      status: 'failed',
      stopReason: 'stopped',
      message: 'stopped by sail stop before implement#1',
    });
    const resumed = await resumeWorkflow({ cwd: repo.dir, adapters: await fakeAdapters(repo.dir), runId: end.runId });
    expect({
      status: readFileSync(join(end.dir, 'STATUS'), 'utf8'),
      journaled: keys(end.dir),
      ran: stubExecutions(repo.dir),
      workspace: existsSync(join(end.dir, 'workspace')),
      leases: leaseFiles(repo.dir),
      summary: summaryOf(end.dir)?.stopReason,
      issues: validateRunDir(end.dir).issues,
      resumed,
    }).toEqual({
      status: 'failed stopped\n',
      journaled: ['intake#1', 'spec#1'],
      ran: ['spec#1'],
      workspace: false,
      leases: [],
      summary: 'stopped',
      issues: [],
      resumed: { refused: `run ${end.runId} failed (stopped): a failed run is final` },
    });
  });
});

test('a CONTROL written as the run starts stops it before intake#1', async () => {
  await withTempRepo(async (repo) => {
    writeStub(repo.dir);
    const control: Consumer = {
      name: 'control',
      onEvent: (event) => {
        if (event.type === 'run:start') requestStop(onlyRun(repo.dir));
      },
    };
    const end = await ran(repo.dir, { consumers: [control] });
    expect(end).toMatchObject({
      status: 'failed',
      stopReason: 'stopped',
      message: 'stopped by sail stop before intake#1',
    });
    expect([keys(end.dir), existsSync(join(end.dir, '00-intake')), validateRunDir(end.dir).issues]).toEqual([
      [],
      false,
      [],
    ]);
  });
});

test('an abort seen at the same boundary as a CONTROL goes first, suspending the run interrupted, and the request waits for the resume, which it suspends before spec#1', async () => {
  await withTempRepo(async (repo) => {
    writeStub(repo.dir);
    const controller = new AbortController();
    const end = await ran(repo.dir, {
      signal: controller.signal,
      onCall: () => {
        requestUnwatch(onlyRun(repo.dir));
        controller.abort();
      },
    });
    expect(end).toMatchObject({ status: 'suspended', stopReason: 'interrupted', message: 'stopped before spec#1' });
    await withTempRepo(async (copy) => {
      copyRun(repo.dir, copy.dir);
      const resumed = await resumeWorkflow({ cwd: copy.dir, adapters: await fakeAdapters(copy.dir), runId: end.runId });
      expect([resumed, stubExecutions(copy.dir)]).toMatchObject([
        { status: 'suspended', stopReason: 'unwatched', message: 'its workflow was unwatched: stopped before spec#1' },
        [],
      ]);
    });
  });
}, 30_000);

test('a stop asked during the call --until names goes ahead of the until suspension: the run fails stopped and releases its workspace and lease (review R1-6)', async () => {
  await withTempRepo(async (repo) => {
    writeStub(repo.dir);
    const end = await ran(repo.dir, {
      until: 'spec',
      onCall: (entry) => {
        if (entry.key === 'spec#1') requestStop(onlyRun(repo.dir));
      },
    });
    expect({
      end: [end.status, end.stopReason],
      journaled: keys(end.dir),
      workspace: existsSync(join(end.dir, 'workspace')),
      leases: leaseFiles(repo.dir),
      control: existsSync(join(end.dir, CONTROL_FILE)),
      issues: validateRunDir(end.dir).issues,
    }).toEqual({
      end: ['failed', 'stopped'],
      journaled: ['intake#1', 'spec#1'],
      workspace: false,
      leases: [],
      control: false,
      issues: [],
    });
  });
});

test('a resume that takes the lease after a sail stop ended the run meanwhile is refused as final: STATUS stays failed stopped and the lease is given back (review R2-2)', async () => {
  await withTempRepo(async (repo) => {
    const runId = await stoppedCopy(repo.dir);
    const end = { runId, dir: join(repo.dir, '.sail-runs', runId) };
    const adapters = await fakeAdapters(repo.dir);
    const { workspace } = adapters.ports;
    const lease = workspace.lease.bind(workspace);
    // A stop that ran to its end while the resume loaded the workflow: STATUS final, the lease released.
    workspace.lease = (...args) => {
      writeStatus(end.dir, 'failed', 'stopped');
      return lease(...args);
    };
    const resumed = await resumeWorkflow({ cwd: repo.dir, adapters, runId: end.runId });
    expect({
      resumed,
      status: readFileSync(join(end.dir, 'STATUS'), 'utf8'),
      leases: leaseFiles(repo.dir),
    }).toEqual({
      resumed: { refused: `run ${end.runId} failed (stopped): a failed run is final` },
      status: 'failed stopped\n',
      leases: [],
    });
  });
});

// Agent calls in a run: brief-to-spec on the fake harness, whose script says what each try of spec#1 does.

/** Runs brief-to-spec from `cwd` on the fixture's `FAKE-1`, which must not be refused. */
const ranAgent = (cwd: string, options: Partial<RunWorkflowOptions> = {}): Promise<RunEnd> =>
  ran(cwd, { workflow: AGENT_WORKFLOW, ...options });

test('an agent call is journaled once, with the output, the files and the result of its last try, and ran on the model its alias names', async () => {
  await withTempRepo(async (repo) => {
    writeAgentFixture(repo.dir, [submits(NO_TASKS, 0.125), submits(SPEC, 0.25)]);
    writeFileSync(join(repo.dir, 'AGENTS.md'), 'Indent with tabs.\n');
    const end = await ranAgent(repo.dir);

    expect(end).toMatchObject({
      status: 'completed',
      result: { outcome: 'passed', output: { published: true, bytes: 17 } },
    });
    expect(journaled(end.dir)).toEqual(['intake#1 passed', 'brief#1 passed', 'spec#1 done', 'publish#1 passed']);
    // The input the stages bind is what the intake built from the seeded ticket.
    expect(entryOf(end.dir, 'intake#1')?.output).toEqual(TICKET);
    expect(entryOf(end.dir, 'spec#1')).toMatchObject({
      stage: 'spec',
      call: 1,
      output: SPEC,
      reason: null,
      files: { 'spec.md': '02-spec/call-1/try-2/spec.md' },
      resultPath: '02-spec/call-1/try-2/result.json',
    });
    expect(specResult(end.dir, 2)).toMatchObject({
      outcome: 'done',
      try: 2,
      validationTry: 2,
      harness: { adapter: 'fake', model: 'claude-opus-5-5', sessionId: 'fake-session-spec-1-try-2' },
      prompt: { path: '02-spec/call-1/try-2/prompt.md', untrusted: 1, conventions: ['AGENTS.md'] },
      usage: usageOf(0.25),
    });
    // The prompt the second session was sent: the ticket's title wrapped, the brief where this try holds it, the
    // repository's conventions and what the first try got wrong.
    const prompt = specFile(end.dir, 'prompt.md', 2) ?? '';
    const title = '<untrusted-input source="ticket.title">Add a --shout flag</untrusted-input>';
    const brief = join(specDir(end.dir, 2), 'in', 'brief.md');
    expect(prompt).toStartWith(`Write a spec for FAKE-1: ${title}\n\nRead the brief at ${brief}.`);
    expect([prompt.includes('Indent with tabs.'), prompt.includes(NO_TASKS_MESSAGE)]).toEqual([true, true]);
    // publish read the file the journal holds: the second try's.
    const publish = JSON.parse(readFileSync(join(end.dir, '03-publish', 'call-1', 'result.json'), 'utf8'));
    expect(publish.consumed).toEqual({ spec: '02-spec/call-1/try-2/spec.md' });
    expect(validateRunDir(end.dir).issues.map(formatIssue)).toEqual([]);
  });
}, 20_000);

test('the conventions project.yaml lists, and not the defaults, reach the agent prompts of a run', async () => {
  await withTempRepo(async (repo) => {
    const sail = writeAgentFixture(repo.dir, [submits(SPEC, 0.25)]);
    edit(sail, 'project.yaml', 'budgets:', 'conventions: [docs/STYLE.md]\nbudgets:');
    expect(readConfig(sail)).toMatchObject({ conventions: ['docs/STYLE.md'] });
    writeFileSync(join(repo.dir, 'AGENTS.md'), 'Indent with tabs.\n');
    write(repo.dir, 'docs/STYLE.md', 'Sentence case in headings.\n');

    const end = await ranAgent(repo.dir);
    expect(end).toMatchObject({ status: 'completed' });
    expect(specResult(end.dir)).toMatchObject({ prompt: { conventions: ['docs/STYLE.md'] } });
    const prompt = specFile(end.dir, 'prompt.md') ?? '';
    expect([prompt.includes('Sentence case in headings.'), prompt.includes('Indent with tabs.')]).toEqual([
      true,
      false,
    ]);
  });
}, 20_000);

test('a blocked agent call is journaled with its reason, which reaches the workflow, and its run.fail', async () => {
  await withTempRepo(async (repo) => {
    const reason = 'The brief has no acceptance criteria.';
    writeAgentFixture(repo.dir, [{ outcome: 'blocked', reason, usage: usageOf(0.125) }]);
    const end = await ranAgent(repo.dir);

    expect(end).toMatchObject({ status: 'failed', stopReason: 'workflow_failed', message: `spec blocked: ${reason}` });
    expect(journaled(end.dir)).toEqual(['intake#1 passed', 'brief#1 passed', 'spec#1 blocked']);
    expect(entryOf(end.dir, 'spec#1')).toMatchObject({
      output: null,
      reason,
      files: {},
      resultPath: '02-spec/call-1/result.json',
    });
    expect(specResult(end.dir)).toMatchObject({ outcome: 'blocked', output: null, reason, usage: usageOf(0.125) });
    expect(readStatus(end.dir)).toEqual({ status: 'failed', stopReason: 'workflow_failed' });
    expect(validateRunDir(end.dir).issues.map(formatIssue)).toEqual([]);
  });
}, 20_000);

test('an agent call that ends in error fails the run with stage_error and its message, unless the workflow asked for its error', async () => {
  const overloaded = 'harness: model overloaded';
  await withTempRepo(async (repo) => {
    writeAgentFixture(repo.dir, [{ outcome: 'error', message: 'model overloaded' }]);
    const end = await ranAgent(repo.dir);
    expect(end).toMatchObject({
      status: 'failed',
      stopReason: 'stage_error',
      message: `spec#1 ended in error: ${overloaded}`,
    });
    expect(entryOf(end.dir, 'spec#1')).toMatchObject({ outcome: 'error', output: null, reason: overloaded, files: {} });
    const reported = readEvents(end.dir).flatMap((event) => (event.type === 'error:harness' ? [event] : []));
    expect(reported.map(({ key, message }) => ({ key, message }))).toEqual([
      { key: 'spec#1', message: 'model overloaded' },
    ]);
  });
  await withTempRepo(async (repo) => {
    const sail = writeAgentFixture(repo.dir, [{ outcome: 'error', message: 'model overloaded' }]);
    edit(sail, WORKFLOW_FILE, SPEC_CALL, SPEC_CALL_RETURNING_ERRORS);
    const end = await ranAgent(repo.dir);
    expect(end).toMatchObject({ status: 'failed', stopReason: 'workflow_failed', message: `handled: ${overloaded}` });
  });
}, 20_000);

test('an abort during an agent session suspends the run with the call unjournaled, and a resume runs it as its next try on the model the run started with', async () => {
  await withTempRepo(async (repo) => {
    const runId = await withTempRepo(async (from) => {
      writeAgentFixture(from.dir, [submits(SPEC, 0.5, { turns: 2, delayMs: 30_000 }), submits(SPEC, 0.25)]);
      const controller = new AbortController();
      const running = ranAgent(from.dir, { signal: controller.signal });
      const end = await interruptInSession(from.dir, running, () => controller.abort());

      expect(end).toMatchObject({ status: 'suspended', stopReason: 'interrupted', message: 'stopped during spec#1' });
      expect(journaled(end.dir)).toEqual(['intake#1 passed', 'brief#1 passed']);
      // What the session had spent is kept, and nothing it submitted was checked.
      expect(specResult(end.dir)).toMatchObject({
        outcome: 'error',
        errors: [{ reason: 'harness', message: 'aborted' }],
        validationTry: 1,
        validationFailed: false,
        harness: { model: 'claude-opus-5-5' },
        usage: usageOf(0.5),
      });
      copyRun(from.dir, repo.dir);
      return end.runId;
    });

    // The alias names another model by now. The run goes on with the one its roster froze.
    edit(join(repo.dir, '.sail'), 'project.yaml', 'deep: claude-opus-5-5', 'deep: claude-next');
    const dir = join(repo.dir, '.sail-runs', runId);
    const adapters = await fakeAdapters(repo.dir);
    expect(await resumeWorkflow({ cwd: repo.dir, adapters, runId })).toMatchObject({
      status: 'completed',
    });
    expect(journaled(dir)).toEqual(['intake#1 passed', 'brief#1 passed', 'spec#1 done', 'publish#1 passed']);
    expect(entryOf(dir, 'spec#1')?.resultPath).toBe('02-spec/call-1/try-2/result.json');
    expect(specResult(dir, 2)).toMatchObject({
      outcome: 'done',
      try: 2,
      validationTry: 1,
      harness: { model: 'claude-opus-5-5' },
    });
    expect(sessions(readEvents(dir))).toEqual([
      'start fake-session-spec-1',
      'end fake-session-spec-1 error 0.5',
      'start fake-session-spec-1-try-2',
      'end fake-session-spec-1-try-2 done 0.25',
    ]);
    expect(stubExecutions(repo.dir)).toEqual(['brief#1', 'publish#1']);
    expect(validateRunDir(dir).issues.map(formatIssue)).toEqual([]);
  });
}, 40_000);

test('a resume replays a journaled agent call from the journal, and starts no session for it', async () => {
  await withTempRepo(async (repo) => {
    const runId = await withTempRepo(async (from) => {
      writeAgentFixture(from.dir, [submits(SPEC, 0.25)]);
      setSleepAt(from.dir, 'publish#1');
      const controller = new AbortController();
      const running = ranAgent(from.dir, { signal: controller.signal });
      const { end } = await interruptWhenAsleep(from.dir, running, () => controller.abort());
      expect(end).toMatchObject({ status: 'suspended', message: 'stopped during publish#1' });
      expect(journaled(end.dir)).toEqual(['intake#1 passed', 'brief#1 passed', 'spec#1 done']);
      copyRun(from.dir, repo.dir);
      return end.runId;
    });

    // Any session from here on would fail, and the run with it.
    writeHarnessScript(repo.dir, { spec: [{ outcome: 'error', message: 'a session the journal made needless' }] });
    const dir = join(repo.dir, '.sail-runs', runId);
    const adapters = await fakeAdapters(repo.dir);
    expect(await resumeWorkflow({ cwd: repo.dir, adapters, runId })).toMatchObject({
      status: 'completed',
      result: { outcome: 'passed', output: { published: true, bytes: 17 } },
    });
    expect(journaled(dir)).toEqual(['intake#1 passed', 'brief#1 passed', 'spec#1 done', 'publish#1 passed']);
    expect(sessions(readEvents(dir))).toEqual(['start fake-session-spec-1', 'end fake-session-spec-1 done 0.25']);
    expect(existsSync(specDir(dir, 2))).toBe(false);
    expect(stubExecutions(repo.dir)).toEqual(['brief#1', 'publish#1', 'publish#1']);
  });
}, 40_000);

test('a try whose last events were lost is counted once, from its result, however often the run resumes', async () => {
  await withTempRepo(async (repo) => {
    const answers = [
      submits(NO_TASKS, 0.125, { turns: 2 }),
      submits(SPEC, 0.5, { turns: 2, delayMs: 30_000 }),
      submits(SPEC, 0.25),
    ];
    const runId = await withTempRepo(async (second) => {
      const id = await withTempRepo(async (first) => {
        writeAgentFixture(first.dir, answers);
        // Stopped as the first try ends: its result is on disk, and no corrective try has started.
        const controller = new AbortController();
        const stop: Consumer = {
          name: 'stop',
          onEvent: (event) => {
            if (event.type === 'stage:end' && event.key === 'spec#1') controller.abort();
          },
        };
        const end = await ranAgent(first.dir, { signal: controller.signal, consumers: [stop] });
        expect(end).toMatchObject({ status: 'suspended', message: 'stopped during spec#1' });
        expect(specResult(end.dir)).toMatchObject({ outcome: 'error', try: 1, validationFailed: true });
        expect(existsSync(specDir(end.dir, 2))).toBe(false);

        // A power loss took the unsynced tail of the events: all that followed the session's first usage update.
        const path = join(end.dir, 'events.ndjson');
        const lines = readFileSync(path, 'utf8').trimEnd().split('\n');
        const kept = lines.findIndex((line) => JSON.parse(line).type === 'usage:update') + 1;
        expect(kept).toBeGreaterThan(0);
        writeFileSync(
          path,
          lines
            .slice(0, kept)
            .map((line) => `${line}\n`)
            .join(''),
        );
        copyRun(first.dir, second.dir);
        return end.runId;
      });

      // The first resume is interrupted in its corrective session.
      const controller = new AbortController();
      const adapters = await fakeAdapters(second.dir);
      const running = resumeWorkflow({
        cwd: second.dir,
        adapters,
        runId: id,
        signal: controller.signal,
      });
      expect(await interruptInSession(second.dir, running, () => controller.abort(), 2)).toMatchObject({
        status: 'suspended',
      });
      copyRun(second.dir, repo.dir);
      return id;
    });

    const dir = join(repo.dir, '.sail-runs', runId);
    const adapters = await fakeAdapters(repo.dir);
    expect(await resumeWorkflow({ cwd: repo.dir, adapters, runId })).toMatchObject({
      status: 'completed',
    });
    const all = readEvents(dir);
    const ends = all.flatMap((event) =>
      event.type === 'harness:session_end' ? [[event.sessionId, event.usage.costUsd]] : [],
    );
    expect(ends).toEqual([
      ['fake-session-spec-1', 0.125],
      ['fake-session-spec-1-try-2', 0.5],
      ['fake-session-spec-1-try-3', 0.25],
    ]);
    const stageEnds = all.flatMap((event) =>
      event.type === 'stage:end' && event.key === 'spec#1' ? [`${event.try} ${event.outcome}`] : [],
    );
    expect(stageEnds).toEqual(['1 error', '2 error', '3 done']);
    expect(specResult(dir, 3)).toMatchObject({ outcome: 'done', try: 3, validationTry: 2 });

    const written = summaryText(dir);
    const summary = summaryOf(dir);
    expect(summary?.totals.usage).toEqual({ inputTokens: 7000, outputTokens: 700, costUsd: 0.875 });
    expect(summary?.calls.map((call) => `${call.key} ${call.outcome}`)).toEqual([
      'intake#1 passed',
      'brief#1 passed',
      'spec#1 done',
      'publish#1 passed',
    ]);
    rmSync(join(dir, 'summary.json'));
    expect(rebuildSummary(dir)).toEqual({ summary: summary as Summary, path: join(dir, 'summary.json') });
    expect(summaryText(dir)).toBe(written);
  });
}, 60_000);

// The relay in a run (D8): what an adapter emits while the run is going reaches its stream.

const PUSHED: ProviderEvent = { type: 'codehost:pushed', branch: 'sail/FAKE-1', headSha: 'a'.repeat(40) };
const LEASED: ProviderEvent = { type: 'workspace:leased', remote: 'fake://codehost/stub', branch: 'sail/FAKE-1' };
const COMMENTED: ProviderEvent = { type: 'ticket:commented', ticketKey: 'FAKE-1', body: 'between two calls' };

test("what an adapter emits while a call runs is in events.ndjson with that call's key, right after the event it followed: a workspace event has no key, and neither has a ticket event between two calls", async () => {
  await withTempRepo(async (repo) => {
    writeStub(repo.dir, { testsPassAt: 1 });
    const adapters = await fakeAdapters(repo.dir);
    const during: Consumer = {
      name: 'provider',
      onEvent(event) {
        if (event.type !== 'script:exec' || event.key !== 'spec#1') return;
        adapters.relay.emit(PUSHED);
        adapters.relay.emit(LEASED);
      },
    };
    const end = await ran(repo.dir, {
      adapters,
      consumers: [during],
      onCall: (entry) => {
        if (entry.key === 'spec#1') adapters.relay.emit(COMMENTED);
      },
    });

    const list = events(end.dir);
    const exec = list.findIndex((event) => event.type === 'script:exec' && event.key === 'spec#1');
    const envelope = { ts: expect.any(String), runId: end.runId };
    expect(list.slice(exec + 1, exec + 3)).toEqual([
      { seq: exec + 2, ...envelope, key: 'spec#1', ...PUSHED },
      { seq: exec + 3, ...envelope, ...LEASED },
    ]);
    expect(list[exec + 2]).not.toHaveProperty('key');

    // The claim's own comment is ahead of it in the stream, so this one is found by its body.
    const commented = list.findIndex((event) => event.type === 'ticket:commented' && event.body === COMMENTED.body);
    expect(outline(list.slice(commented - 1, commented + 1))).toEqual(['journal:append spec#1', 'ticket:commented']);
    expect(list[commented]).toEqual({ seq: commented + 1, ...envelope, ...COMMENTED });
    expect(list[commented]).not.toHaveProperty('key');

    expect(end.status).toBe('completed');
    expect(seqs(list)).toEqual(gapless(list));
    expect(list.flatMap((event) => validateDocument('sail.event.v1', event)).map(formatIssue)).toEqual([]);
    expect(validateRunDir(end.dir).issues).toEqual([]);
  });
});

test('once run:end is out nothing an adapter emits reaches the file, and the run lets go of the relay', async () => {
  await withTempRepo(async (repo) => {
    writeStub(repo.dir, { testsPassAt: 1 });
    const adapters = await fakeAdapters(repo.dir);
    const atTheEnd: Consumer = {
      name: 'provider',
      onEvent(event) {
        if (event.type === 'run:end') adapters.relay.emit(PUSHED);
      },
    };
    const end = await ran(repo.dir, { adapters, consumers: [atTheEnd] });
    const written = eventsText(end.dir);
    adapters.relay.emit(PUSHED);

    // The relay is free again: a sink attaches, and receives.
    const seen: ProviderEvent[] = [];
    adapters.relay.attach((event) => seen.push(event));
    adapters.relay.emit(LEASED);
    expect(seen).toEqual([LEASED]);
    expect(eventsText(end.dir)).toBe(written);
    const list = events(end.dir);
    expect(list.at(-1)?.type).toBe('run:end');
    // Neither of the two emitted from the end on is in the stream, which holds no push of its own.
    expect(list.filter((event) => event.type === 'codehost:pushed')).toEqual([]);
  });
});

test('a run that crashes lets go of the relay too', async () => {
  await withTempRepo(async (repo) => {
    const sail = writeStub(repo.dir);
    edit(
      sail,
      'workflows/ticket-to-pr/stages/spec/run.sh',
      "printf '# Spec",
      'echo not-json >>"$STAGE_OUT/../../journal.ndjson"\nprintf \'# Spec',
    );
    const adapters = await fakeAdapters(repo.dir);
    const error = await ran(repo.dir, { adapters }).catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(JournalError);

    const seen: ProviderEvent[] = [];
    adapters.relay.attach((event) => seen.push(event));
    adapters.relay.emit(LEASED);
    expect(seen).toEqual([LEASED]);
    expect(events(onlyRun(repo.dir)).at(-1)?.type).toBe('error:crash');
  });
});

// The run's clock (D8): every time a run records is a reading of the clock it is given, and its id's random part is the
// bytes it is given, so the same run writes the same run directory.

const GOLDEN_ID = 'FAKE-1-01M3BWNZM08Q4T6V2XRJ5KWD3N';

/** Runs the stub's `FAKE-1` from `cwd` on `clock` and the golden id bytes, with the fakes reading the same clock. */
async function ranOnClock(cwd: string, clock: SteppingClock): Promise<RunEnd> {
  return ran(cwd, { adapters: await fakeAdapters(cwd, {}, { now: clock }), clock, random: goldenRandom });
}

/** Every `result.json` in a run directory, parsed, by its path relative to the run directory. */
function resultsIn(runDir: string): Record<string, { startedAt: string; finishedAt: string; durationMs: number }> {
  const paths = (readdirSync(runDir, { recursive: true }) as string[]).filter((path) => path.endsWith('result.json'));
  return Object.fromEntries(paths.sort().map((path) => [path, JSON.parse(readFileSync(join(runDir, path), 'utf8'))]));
}

/** Every file under `dir`, by its path relative to it, with the sha256 of its bytes. */
function hashed(dir: string): Record<string, string> {
  const entries = readdirSync(dir, { recursive: true, withFileTypes: true }).filter((entry) => entry.isFile());
  const paths = entries.map((entry) => join(entry.parentPath, entry.name)).sort();
  return Object.fromEntries(paths.map((path) => [path.slice(dir.length + 1), sha256(path)]));
}

const journalText = (runDir: string): string => readFileSync(join(runDir, 'journal.ndjson'), 'utf8');

/** `times`, each as its distance in ms from `start`. */
const since = (start: string, times: readonly string[]) => times.map((time) => Date.parse(time) - Date.parse(start));

test('a run on a stepping clock and fixed id bytes takes its id from them, and every time and duration it records from the clock', async () => {
  await withTempRepo(async (repo) => {
    writeStub(repo.dir);
    const clock = steppingClock(GOLDEN_START, GOLDEN_STEP_MS);
    const end = await ranOnClock(repo.dir, clock);
    expect([end.runId, end.status]).toEqual([GOLDEN_ID, 'completed']);
    expect(JSON.parse(readFileSync(join(end.dir, 'run.json'), 'utf8')).startedAt).toBe(GOLDEN_START);

    const list = events(end.dir);
    const results = Object.values(resultsIn(end.dir));
    const journal = readJournal(end.dir).entries;
    expect([results.length, journal.length]).toEqual([8, 8]);
    const stamps = list.map((event) => event.ts);
    const recorded = journal.map((entry) => entry.recordedAt);
    const times = [...stamps, ...recorded, ...results.flatMap((result) => [result.startedAt, result.finishedAt])];
    // Each is a reading: the start plus a whole number of steps.
    expect(since(GOLDEN_START, times).filter((ms) => ms < 0 || ms % GOLDEN_STEP_MS !== 0)).toEqual([]);
    // None goes back in time: the stream and the journal in order, and each try ends after it starts.
    expect([stamps, recorded]).toEqual([[...stamps].sort(), [...recorded].sort()]);
    expect(results.filter((result) => result.finishedAt <= result.startedAt)).toEqual([]);

    const exits = list.flatMap((event) => (event.type === 'script:exit' ? [event.durationMs] : []));
    expect(exits).toEqual([100, 100, 100, 100, 100, 100, 100]);
    const durations = results.map((result) => result.durationMs);
    expect(durations.filter((ms) => ms <= 0 || ms % GOLDEN_STEP_MS !== 0)).toEqual([]);
    const last = clock.readings.at(-1)?.toISOString() ?? '';
    expect(times.filter((time) => time > last)).toEqual([]);
  });
});

test('two runs on the same clock and id bytes, in two repositories, write the same run directory, byte for byte', async () => {
  await withTempRepo(async (repo) => {
    const [first, second] = [join(repo.dir, 'first'), join(repo.dir, 'second-and-longer')];
    mkdirSync(first);
    mkdirSync(second);
    // One `.sail/`, copied: the stub writes an id of its own into each workflow it writes.
    cpSync(writeStub(first), join(second, '.sail'), { recursive: true });
    const one = await ranOnClock(first, steppingClock(GOLDEN_START, GOLDEN_STEP_MS));
    const two = await ranOnClock(second, steppingClock(GOLDEN_START, GOLDEN_STEP_MS));
    expect([one.runId, two.runId]).toEqual([GOLDEN_ID, GOLDEN_ID]);

    const files = hashed(one.dir);
    expect(Object.keys(files)).toContain('events.ndjson');
    expect(Object.keys(files)).toContain('03-tests/call-2/result.json');
    expect(Object.keys(files).length).toBeGreaterThan(30);
    expect(hashed(two.dir)).toEqual(files);
  });
});

test("a resume on a clock of its own stamps what it adds with that clock's readings, and leaves what the first process wrote as it was", async () => {
  await withTempRepo(async (repo) => {
    const before = new Date().toISOString();
    const runId = await stoppedCopy(repo.dir);
    const dir = join(repo.dir, '.sail-runs', runId);
    const [firstEvents, firstJournal, firstResults] = [eventsText(dir), journalText(dir), resultsIn(dir)];
    // With no clock given, the first process read the system's: every time it recorded lies inside this test.
    const first = [
      ...events(dir).map((event) => event.ts),
      ...readJournal(dir).entries.map((entry) => entry.recordedAt),
      ...Object.values(firstResults).flatMap((result) => [result.startedAt, result.finishedAt]),
    ];
    expect(first.filter((time) => time < before || time > new Date().toISOString())).toEqual([]);

    const clock = steppingClock('2031-01-01T00:00:00.000Z', GOLDEN_STEP_MS);
    const end = await resumeWorkflow({
      cwd: repo.dir,
      runId,
      adapters: await fakeAdapters(repo.dir, {}, { now: clock }),
      clock,
    });
    expect(end).toMatchObject({ status: 'completed' });
    const readings = new Set(clock.readings.map((reading) => reading.toISOString()));

    expect(eventsText(dir).startsWith(firstEvents)).toBe(true);
    const added = eventsText(dir)
      .slice(firstEvents.length)
      .split('\n')
      .filter((line) => line !== '')
      .map((line) => JSON.parse(line).ts as string);
    expect(added.length).toBeGreaterThan(30);
    expect(added.filter((ts) => !readings.has(ts))).toEqual([]);

    expect(journalText(dir).startsWith(firstJournal)).toBe(true);
    const lines = readJournal(dir).entries.slice(2);
    expect(lines.map((entry) => entry.key)).toEqual([
      'implement#1',
      'tests#1',
      'implement#2',
      'tests#2',
      'self-review#1',
      'publish#1',
    ]);
    expect(lines.filter((entry) => !readings.has(entry.recordedAt))).toEqual([]);

    const results = resultsIn(dir);
    const ran = Object.keys(results).filter((path) => !Object.hasOwn(firstResults, path));
    expect(ran).toHaveLength(6);
    expect(
      ran.filter(
        (path) => !readings.has(results[path]?.startedAt ?? '') || !readings.has(results[path]?.finishedAt ?? ''),
      ),
    ).toEqual([]);
    expect(Object.keys(firstResults).map((path) => results[path])).toEqual(Object.values(firstResults));
  });
});

// A script's port events (D12).

const SPEC_SCRIPT = 'workflows/ticket-to-pr/stages/spec/run.sh';

test("a script step's sail port leaves its provider event in the run's stream under the step's key, between the step's script:exec and script:exit, and in the call directory's port events file", async () => {
  const fetches = (sail: string) =>
    edit(sail, SPEC_SCRIPT, "printf '# Spec", "sail port ticket-source get FAKE-1 >/dev/null\nprintf '# Spec");
  await stubRun({}, fetches, (end) => {
    const own = events(end.dir).filter((event) => 'key' in event && event.key === 'spec#1');
    const from = own.findIndex((event) => event.type === 'script:exec');
    const first = own[from]?.seq ?? 0;
    expect(own.slice(from, from + 3).map((event) => [event.type, event.seq - first])).toEqual([
      ['script:exec', 0],
      ['ticket:fetched', 1],
      ['script:exit', 2],
    ]);
    expect(own[from + 1]).toMatchObject({ runId: end.runId, key: 'spec#1', ticketKey: 'FAKE-1', comments: 2 });
    const file = readFileSync(join(end.dir, '01-spec', 'call-1', 'port-events.ndjson'), 'utf8');
    expect(file).toStartWith('{"type":"ticket:fetched","ticketKey":"FAKE-1",');
    expect(file.split('\n')).toHaveLength(2);
    expect(end.status).toBe('completed');
    expect(validateRunDir(end.dir).issues).toEqual([]);
  });
});

// The run's ticket in its summary (D16).

const STUB_TICKET = { ticketKey: 'FAKE-1', title: 'Add a greeting', url: 'fake://tickets/FAKE-1' };

test("a run's summary.json names its ticket by its key, title and URL, from the intake's fetch, and a resumed run's summary still holds it", async () => {
  await withTempRepo(async (repo) => {
    const runId = await stoppedCopy(repo.dir);
    const dir = join(repo.dir, '.sail-runs', runId);
    expect(summaryOf(dir)?.ticket).toEqual(STUB_TICKET);
    expect(validateDocument('sail.summary.v1', summaryOf(dir)).map(formatIssue)).toEqual([]);
    // The summary seeds itself from the events file: the fetch is in the first process's lines.
    await resumeWorkflow({ cwd: repo.dir, adapters: await fakeAdapters(repo.dir), runId });
    const summary = summaryOf(dir);
    expect([summary?.status, summary?.ticket]).toEqual(['completed', STUB_TICKET]);
    expect(validateRunDir(dir).issues).toEqual([]);
  });
});

// Documents through the runtime: the stage declares one, and the run's bindings fill its template.

/** Gives the agent fixture's spec stage `produces`, with `doc` and `countItems` imported, and its template. */
function documentedSpec(sail: string, produces: string): void {
  write(
    sail,
    `${SPEC_STAGE}/templates/spec.md`,
    '# Spec for {{ticket.ticketKey}}\n\n{{ticket.title}}\n\n{{tasks: one per task}}\n',
  );
  edit(
    sail,
    `${SPEC_STAGE}/stage.ts`,
    "import { agent, file, value, z } from 'sail';",
    "import { agent, countItems, doc, file, value, z } from 'sail';",
  );
  edit(sail, `${SPEC_STAGE}/stage.ts`, "  produces: { 'spec.md': 'file' },", `  produces: ${produces},`);
}

test("a run's agent step finds its document's template in $STAGE_OUT, filled with the run's bindings, and a session that leaves it as it is produces it so", async () => {
  await withTempRepo(async (repo) => {
    const sail = writeAgentFixture(repo.dir, [submits(SPEC, 0.25, { files: {} })]);
    documentedSpec(sail, "{ 'spec.md': doc('./templates/spec.md') }");
    const end = await ranAgent(repo.dir);

    expect(end).toMatchObject({ status: 'completed' });
    expect(journaled(end.dir)).toEqual(['intake#1 passed', 'brief#1 passed', 'spec#1 done', 'publish#1 passed']);
    expect(specFile(end.dir, 'spec.md')).toBe(
      '# Spec for FAKE-1\n\n<untrusted-input source="ticket.title">\nAdd a --shout flag\n</untrusted-input>\n\n{{tasks: one per task}}\n',
    );
  });
}, 20_000);

test("a run whose agent step's documents derive one key twice fails before the call, as one that can't run", async () => {
  await withTempRepo(async (repo) => {
    const sail = writeAgentFixture(repo.dir, [submits(SPEC, 0.25)]);
    const twice = "doc('./templates/spec.md', [countItems('Tasks')])";
    documentedSpec(sail, `{ 'spec.md': ${twice}, 'plan.md': ${twice} }`);
    const end = await ranAgent(repo.dir);

    expect(end).toMatchObject({
      status: 'failed',
      stopReason: 'workflow_failed',
      message:
        "spec#1 can't run: derived key 'tasks' comes from both 'spec.md' (countItems(Tasks)) and 'plan.md' (countItems(Tasks))",
    });
    expect(journaled(end.dir)).toEqual(['intake#1 passed', 'brief#1 passed']);
  });
}, 20_000);

// A group: trio's a, b and c in one run.all(), on the fake harness, then d. Each call is journaled as it completes.

/** Runs trio from `cwd` on the fixture's `FAKE-1`, which must not be refused. */
const ranTrio = (cwd: string, options: Partial<RunWorkflowOptions> = {}): Promise<RunEnd> =>
  ran(cwd, { workflow: TRIO, ...options });

/** Each event's type, with its key when it has one: `stage:start a#1`. */
const typed = (list: readonly SailEvent[]) =>
  list.map((event) => ('key' in event ? `${event.type} ${event.key}` : event.type));
const ofType = <T extends SailEvent['type']>(list: readonly SailEvent[], type: T) =>
  list.filter((event): event is Extract<SailEvent, { type: T }> => event.type === type);
/** The events a group's calls emit: those carrying one of its keys. */
const CALL_TYPES = ['stage:', 'harness:', 'agent:', 'usage:', 'prompt:', 'input:', 'output:', 'file:'];

test("a group's calls run at once and are journaled as each completes, the workflow gets their results in the order given, and all:start and all:end bracket them", async () => {
  await withTempRepo(async (repo) => {
    writeTrio(repo.dir, { a: 300, b: 100, c: 200 });
    const end = await ranTrio(repo.dir);

    expect(end).toMatchObject({ status: 'completed', result: { names: ['a', 'b', 'c'], last: 'done' } });
    expect(journaled(end.dir)).toEqual(['intake#1 passed', 'b#1 done', 'c#1 done', 'a#1 done', 'd#1 done']);
    expect(readJournal(end.dir).entries.map((entry) => entry.group)).toEqual([
      undefined,
      TRIO_KEYS,
      TRIO_KEYS,
      TRIO_KEYS,
      undefined,
    ]);
    const list = events(end.dir);
    expect(list.flatMap((event) => validateDocument('sail.event.v1', event)).map(formatIssue)).toEqual([]);
    const starts = list.flatMap((event, i) => (event.type === 'stage:start' && event.key !== 'd#1' ? [i] : []));
    const firstEnd = list.findIndex((event) => event.type === 'stage:end');
    expect({ starts: starts.length, before: starts.every((i) => i < firstEnd) }).toEqual({ starts: 3, before: true });

    const [started] = ofType(list, 'all:start');
    const [ended, ...more] = ofType(list, 'all:end');
    expect({ keys: started?.keys, running: started?.running, more: more.length }).toEqual({
      keys: TRIO_KEYS,
      running: TRIO_KEYS,
      more: 0,
    });
    expect(ended?.outcomes).toEqual({ 'a#1': 'done', 'b#1': 'done', 'c#1': 'done' });
    expect(ended?.durationMs).toBeLessThan(600);
    const from = list.indexOf(started as SailEvent);
    const to = list.indexOf(ended as SailEvent);
    expect(typed(list.slice(to - 1, to + 2))).toEqual(['journal:append a#1', 'all:end', 'workflow:route']);
    // Inside the bracket every event of a call carries its own key, a group's key.
    const inside = list.slice(from + 1, to).filter((event) => CALL_TYPES.some((type) => event.type.startsWith(type)));
    expect(inside.length).toBeGreaterThan(9);
    expect(inside.filter((event) => !TRIO_KEYS.includes((event as { key?: string }).key ?? ''))).toEqual([]);
  });
}, 30_000);

test("a call of a group that ends in error lets its siblings end and be journaled, then fails the run with stage_error, and all:end carries every call's outcome", async () => {
  await withTempRepo(async (repo) => {
    writeTrio(repo.dir, { a: 300, b: 100, c: 200 }, { b: [{ outcome: 'error', message: 'b broke' }] });
    const end = await ranTrio(repo.dir);

    expect(end).toMatchObject({
      status: 'failed',
      stopReason: 'stage_error',
      message: 'b#1 ended in error: harness: b broke',
    });
    expect(journaled(end.dir)).toEqual(['intake#1 passed', 'b#1 error', 'c#1 done', 'a#1 done']);
    const ends = ofType(events(end.dir), 'all:end');
    expect(ends.map((event) => event.outcomes)).toEqual([{ 'a#1': 'done', 'b#1': 'error', 'c#1': 'done' }]);
  });
}, 30_000);

test('an abort after a call of a group completes suspends the run with that call journaled and no all:end, and a resume runs only the others', async () => {
  await withTempRepo(async (repo) => {
    const runId = await withTempRepo(async (from) => {
      writeTrio(from.dir, { a: 20_000, b: 100, c: 20_000 });
      const controller = new AbortController();
      const end = await ranTrio(from.dir, {
        signal: controller.signal,
        onCall: (entry) => {
          if (entry.key === 'b#1') controller.abort();
        },
      });
      expect(end).toMatchObject({
        status: 'suspended',
        stopReason: 'interrupted',
        message: 'stopped during the group a#1, b#1, c#1',
      });
      expect(journaled(end.dir)).toEqual(['intake#1 passed', 'b#1 done']);
      expect(ofType(events(end.dir), 'all:end')).toEqual([]);
      copyRun(from.dir, repo.dir);
      return end.runId;
    });

    writeTrio(repo.dir, { a: 50, b: 50, c: 50 });
    const dir = join(repo.dir, '.sail-runs', runId);
    const before = events(dir).length;
    const adapters = await fakeAdapters(repo.dir);
    expect(await resumeWorkflow({ cwd: repo.dir, adapters, runId })).toMatchObject({
      status: 'completed',
      result: { names: ['a', 'b', 'c'], last: 'done' },
    });
    const resumed = events(dir).slice(before);
    expect(ofType(resumed, 'stage:start').map((event) => event.key)).toEqual(['a#1', 'c#1', 'd#1']);
    expect(ofType(resumed, 'all:start').map((event) => [event.keys, event.running])).toEqual([
      [TRIO_KEYS, ['a#1', 'c#1']],
    ]);
    expect(ofType(resumed, 'all:end').map((event) => event.outcomes)).toEqual([
      { 'a#1': 'done', 'b#1': 'done', 'c#1': 'done' },
    ]);
    expect(keys(dir).sort()).toEqual(['a#1', 'b#1', 'c#1', 'd#1', 'intake#1']);
  });
}, 60_000);

test("a group whose third call can't run fails the run with workflow_failed before any of its calls starts", async () => {
  await withTempRepo(async (repo) => {
    const sail = writeTrio(repo.dir, { a: 0, b: 0, c: 0 });
    edit(
      sail,
      `workflows/${TRIO}/workflow.ts`,
      TRIO_GROUP,
      '  const results = await run.all([[a, { brief }], [b, { brief }], [c, { brief, extra: 1 } as never]]);\n',
    );
    const end = await ranTrio(repo.dir);

    expect(end).toMatchObject({
      status: 'failed',
      stopReason: 'workflow_failed',
      message: "c#1 can't run: 'extra' is not a binding of this stage",
    });
    expect(journaled(end.dir)).toEqual(['intake#1 passed']);
    expect(typed(events(end.dir)).filter((type) => type.startsWith('stage:start') || type === 'all:start')).toEqual([]);
  });
}, 30_000);

test('a call of a group that throws inside sail stops its siblings, and the error goes on once they have settled: no all:end, and STATUS stays running', async () => {
  await withTempRepo(async (repo) => {
    writeTrio(repo.dir, { a: 20_000, b: 100, c: 20_000 });
    const crashed = ranTrio(repo.dir, {
      onCall: (entry) => {
        if (entry.key === 'b#1') throw new Error('a bug in sail');
      },
    });
    const started = performance.now();
    expect(
      await crashed.then(
        () => 'resolved',
        (error: Error) => error.message,
      ),
    ).toBe('a bug in sail');
    expect(performance.now() - started).toBeLessThan(10_000);

    const dir = onlyRun(repo.dir);
    expect(readStatus(dir)).toEqual({ status: 'running' });
    expect(journaled(dir)).toEqual(['intake#1 passed', 'b#1 done']);
    const list = events(dir);
    expect(ofType(list, 'all:end')).toEqual([]);
    expect(
      ofType(list, 'stage:end')
        .map((event) => event.key)
        .sort(),
    ).toEqual(['a#1', 'b#1', 'c#1']);
    expect(list.at(-1)).toMatchObject({ type: 'error:crash', message: 'a bug in sail' });
    expect(list.at(-1)).not.toHaveProperty('key');
  });
}, 30_000);

test("until naming a group's stage suspends the run once the whole group is journaled, before the next call", async () => {
  await withTempRepo(async (repo) => {
    writeTrio(repo.dir, { a: 100, b: 300, c: 200 });
    const end = await ranTrio(repo.dir, { until: 'b' });

    expect(end).toMatchObject({
      status: 'suspended',
      stopReason: 'until',
      message: 'stopped after b#1, as --until asked',
    });
    expect(journaled(end.dir)).toEqual(['intake#1 passed', 'a#1 done', 'c#1 done', 'b#1 done']);
    expect(ofType(events(end.dir), 'all:end')).toHaveLength(1);
  });
}, 30_000);

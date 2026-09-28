// runWorkflow() and resumeWorkflow(): a run from start to end through replay, on the stub ticket-to-pr, and a run
// interrupted, then resumed. Each case has a temp repository of its own: one run per .sail/ in a process, and Bun
// caches the workflow's modules by path. So a run resumes in a copy of the repository it was interrupted in.
import { expect, test } from 'bun:test';
import { appendFileSync, existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { type JournalEntry, JournalError, readJournal } from '../../src/engine/journal';
import { readStatus } from '../../src/engine/run-dir';
import { RUN_HEADER_FILE } from '../../src/engine/run-header';
import { type RunEnd, type RunWorkflowOptions, resumeWorkflow, runWorkflow } from '../../src/engine/runtime';
import { formatIssue, validateDocument, validateRunDir } from '../../src/engine/schemas';
import type { Consumer, SailEvent } from '../../src/events/types';
import { copyFixture, edit } from '../helpers/fixture';
import {
  copyRun,
  interruptWhenAsleep,
  type StubOptions,
  stubExecutions,
  swapImplementAndTests,
  writeStub,
} from '../helpers/stub-workflow';
import { withTempRepo } from '../helpers/temp-repo';

const WORKFLOW = 'workflows/ticket-to-pr/workflow.ts';

/** Runs ticket-to-pr from `cwd`, which must not be refused. */
async function ran(cwd: string, options: Partial<RunWorkflowOptions> = {}): Promise<RunEnd> {
  const end = await runWorkflow({ cwd, workflow: 'ticket-to-pr', ...options });
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

test('the stub runs to completion through its fix loop, and every call ran once', async () => {
  await withTempRepo(async (repo) => {
    writeStub(repo.dir);
    const journaled: JournalEntry[] = [];
    let header: string | undefined;
    const end = await ran(repo.dir, {
      onCall: (entry) => {
        journaled.push(entry);
        header ??= sha256(join(repo.dir, '.sail-runs', readdirSync(join(repo.dir, '.sail-runs'))[0] ?? '', 'run.json'));
      },
    });

    expect(end).toMatchObject({
      status: 'completed',
      result: { outcome: 'passed', output: { number: 1, url: 'fake://codehost/stub/pull/1', draft: false }, files: {} },
    });
    expect(end.stopReason).toBeUndefined();
    const { entries } = readJournal(end.dir);
    expect(entries.map((entry) => entry.key)).toEqual([
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
      'failed',
      'passed',
      'passed',
      'passed',
      'passed',
    ]);
    expect(journaled).toEqual(entries);
    expect(readStatus(end.dir)).toEqual({ status: 'completed' });
    expect(stubExecutions(repo.dir)).toEqual(keys(end.dir));
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

test("the fixture's agent stages can't run yet, so the run fails before its first call", async () => {
  await withTempRepo(async (repo) => {
    copyFixture(repo.dir);
    const end = await ran(repo.dir);
    expect(end).toMatchObject({
      status: 'failed',
      stopReason: 'workflow_failed',
      message: "spec#1 can't run: agent steps can't run yet",
    });
    expect(readJournal(end.dir).entries).toEqual([]);
    expect(existsSync(join(end.dir, '01-spec'))).toBe(false);
  });
});

test('a workflow whose calls change between replays fails with determinism_violation', async () => {
  await stubRun(
    {},
    (sail) => {
      edit(sail, WORKFLOW, 'export default workflow(', 'let replays = 0;\n\nexport default workflow(');
      edit(
        sail,
        WORKFLOW,
        '  const s = await run.stage(spec);',
        '  if (replays++ > 0) await run.stage(tests);\n  const s = await run.stage(spec);',
      );
    },
    (end) => {
      expect(end).toMatchObject({
        status: 'failed',
        stopReason: 'determinism_violation',
        message: "the workflow asked for 'tests#1' where the journal has 'spec#1'",
      });
      expect(keys(end.dir)).toEqual(['spec#1']);
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
    const running = runWorkflow({ cwd: repo.dir, workflow: 'ticket-to-pr' });
    await expect(running).rejects.toThrow(JournalError);
    const [runId = ''] = readdirSync(join(repo.dir, '.sail-runs'));
    expect(readStatus(join(repo.dir, '.sail-runs', runId))).toEqual({ status: 'running' });
  });
});

test('a second run from the same .sail/ in a process throws before it writes anything', async () => {
  await withTempRepo(async (repo) => {
    writeStub(repo.dir, { testsPassAt: 1 });
    const first = await ran(repo.dir);
    await expect(runWorkflow({ cwd: repo.dir, workflow: 'ticket-to-pr' })).rejects.toThrow(
      'already started in this process',
    );
    expect(readdirSync(join(repo.dir, '.sail-runs'))).toEqual([first.runId]);
  });
});

test('a refused open passes through, and nothing runs', async () => {
  await withTempRepo(async (repo) => {
    writeStub(repo.dir);
    expect(await runWorkflow({ cwd: repo.dir, workflow: 'nope' })).toEqual({
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

const ALL_KEYS = ['spec#1', 'implement#1', 'tests#1', 'implement#2', 'tests#2', 'self-review#1', 'publish#1'];
const INPUT = { ticketKey: 'FAKE-5', title: 'Greet', url: 'fake://tickets/FAKE-5', acceptanceCriteria: ['greets'] };

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
    expect(keys(end.dir)).toEqual(['spec#1', 'implement#1', 'tests#1']);
    expect(journaled).toEqual(['spec#1', 'implement#1', 'tests#1']);
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

test('an abort before the first call suspends the run before anything runs', async () => {
  await withTempRepo(async (repo) => {
    writeStub(repo.dir);
    const controller = new AbortController();
    controller.abort();
    const end = await ran(repo.dir, { signal: controller.signal });
    expect(end).toMatchObject({ status: 'suspended', stopReason: 'interrupted', message: 'stopped before spec#1' });
    expect(readFileSync(join(end.dir, 'STATUS'), 'utf8')).toBe('suspended interrupted\n');
    expect(keys(end.dir)).toEqual([]);
    expect(existsSync(join(end.dir, '01-spec'))).toBe(false);
    expect(stubExecutions(repo.dir)).toEqual([]);
  });
});

test('an abort does not hide a replay that ends the run', async () => {
  await withTempRepo(async (repo) => {
    const sail = writeStub(repo.dir);
    edit(
      sail,
      WORKFLOW,
      '  const s = await run.stage(spec);',
      "  if (run.input === undefined) return run.fail('no ticket given');\n  const s = await run.stage(spec);",
    );
    const controller = new AbortController();
    controller.abort();
    const end = await ran(repo.dir, { signal: controller.signal });
    expect(end).toEqual({
      runId: end.runId,
      dir: end.dir,
      status: 'failed',
      stopReason: 'workflow_failed',
      message: 'no ticket given',
    });
    expect(readStatus(end.dir)).toEqual({ status: 'failed', stopReason: 'workflow_failed' });
  });
});

test("an abort suspends a run whose replay hangs in the workflow's own code", async () => {
  await withTempRepo(async (repo) => {
    const sail = writeStub(repo.dir);
    edit(
      sail,
      WORKFLOW,
      '  const s = await run.stage(spec);',
      '  await new Promise<void>(() => {});\n  const s = await run.stage(spec);',
    );
    const controller = new AbortController();
    const running = ran(repo.dir, { signal: controller.signal });
    const runs = join(repo.dir, '.sail-runs');
    const started = () => existsSync(runs) && readdirSync(runs).some((id) => existsSync(join(runs, id, 'STATUS')));
    while (!started()) await Bun.sleep(10);
    await Bun.sleep(50);
    controller.abort();
    const end = await running;
    expect(end).toMatchObject({ status: 'suspended', stopReason: 'interrupted', message: 'stopped during the replay' });
    expect(readStatus(end.dir)).toEqual({ status: 'suspended', stopReason: 'interrupted' });
    expect(keys(end.dir)).toEqual([]);
    expect(stubExecutions(repo.dir)).toEqual([]);
  });
});

test('a resume runs the interrupted call again as its next try, and nothing journaled runs again', async () => {
  await withTempRepo(async (repo) => {
    const runId = await interruptedCopy(repo.dir);
    const dir = join(repo.dir, '.sail-runs', runId);
    const header = sha256(join(dir, RUN_HEADER_FILE));
    const end = await resumeWorkflow({ cwd: repo.dir, runId });
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
    expect(readJournal(dir).entries[3]?.resultPath).toBe('02-implement/call-2/try-2/result.json');
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
    const end = await resumeWorkflow({ cwd: repo.dir, runId });
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
    const end = await resumeWorkflow({ cwd: repo.dir, runId });
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
    expect(await resumeWorkflow({ cwd: repo.dir, runId })).toEqual({
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
    await expect(resumeWorkflow({ cwd: repo.dir, runId: end.runId })).rejects.toThrow(
      'already started in this process',
    );
    expect(readFileSync(join(end.dir, 'STATUS'), 'utf8')).toBe(status);
  });
}, 20_000);

test('the input given again on resume is run.input', async () => {
  await withTempRepo(async (repo) => {
    const runId = await interruptedCopy(repo.dir, { input: INPUT });
    edit(
      join(repo.dir, '.sail'),
      WORKFLOW,
      "  return run.stage(publish, { spec: s.files['spec.md'] });",
      '  return run.input;',
    );
    const end = await resumeWorkflow({ cwd: repo.dir, runId, input: INPUT });
    expect(end).toEqual({ runId, dir: join(repo.dir, '.sail-runs', runId), status: 'completed', result: INPUT });
  });
}, 30_000);

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

/** The stub's whole stream, tests passing on their second call. */
const STUB_OUTLINE = [
  'run:start',
  ...callOutline('spec#1', 0, 1),
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
  'run:end',
];

const seqs = (list: readonly SailEvent[]) => list.map((event) => event.seq);
const gapless = (list: readonly SailEvent[]) => list.map((_, i) => i + 1);

test("the stub's run writes its whole event stream to events.ndjson, numbered from 1", async () => {
  await withTempRepo(async (repo) => {
    writeStub(repo.dir);
    const end = await ran(repo.dir);
    const list = events(end.dir);
    console.log(
      list.map((e) => JSON.stringify([e.seq, e.type, 'key' in e ? e.key : 'at' in e ? e.at : null])).join('\n'),
    );

    expect(readdirSync(end.dir).sort()).toEqual([
      '01-spec',
      '02-implement',
      '03-tests',
      '04-self-review',
      '05-publish',
      'STATUS',
      'events.ndjson',
      'journal.ndjson',
      'run.json',
    ]);
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
      expect(outline(list.slice(-3))).toEqual(['journal:append tests#3', 'loop:exit', 'run:end']);
      expect(list.slice(-2)).toMatchObject([
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

    expect(await resumeWorkflow({ cwd: repo.dir, runId })).toMatchObject({ status: 'completed' });
    expect(eventsText(dir).startsWith(before)).toBe(true);
    const list = events(dir);
    expect(seqs(list)).toEqual(gapless(list));
    const resumed = list.slice(interrupted.length);
    expect(outline(resumed.slice(0, 3))).toEqual([
      'loop:iteration',
      'workflow:route tests#1→implement#2',
      'stage:start implement#2',
    ]);
    expect(resumed[2]).toMatchObject({ try: 2 });
    expect(outline(resumed).filter((line) => line.startsWith('run:start'))).toEqual([]);
    expect(resumed.at(-1)).toMatchObject({ type: 'run:end', status: 'completed', replays: 5 });
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

    expect(await resumeWorkflow({ cwd: repo.dir, runId })).toMatchObject({ status: 'completed' });
    const after = eventsText(dir);
    expect(after).not.toContain(torn);
    expect(after.startsWith(before)).toBe(true);
    const list = events(dir);
    expect(seqs(list)).toEqual(gapless(list));
    expect(validateRunDir(dir).issues).toEqual([]);
  });
}, 30_000);

test('a resume refused for its input leaves a torn tail as it was', async () => {
  await withTempRepo(async (repo) => {
    const runId = await interruptedCopy(repo.dir);
    const dir = join(repo.dir, '.sail-runs', runId);
    appendFileSync(join(dir, 'events.ndjson'), '{"seq":99,"ts":"2026-09-28T');
    const before = eventsText(dir);

    expect(await resumeWorkflow({ cwd: repo.dir, runId, input: { ticketKey: 5 } })).toEqual({
      refused: expect.stringMatching(/^the input doesn't match intake 'ticket'/),
    });
    expect(eventsText(dir)).toBe(before);
  });
}, 30_000);

test("an events file whose last line can't be read refuses the resume, and leaves STATUS as it was", async () => {
  await withTempRepo(async (repo) => {
    const runId = await interruptedCopy(repo.dir);
    const dir = join(repo.dir, '.sail-runs', runId);
    const line = events(dir).length + 1;
    appendFileSync(join(dir, 'events.ndjson'), 'not json\n');
    const ranBefore = stubExecutions(repo.dir);

    expect(await resumeWorkflow({ cwd: repo.dir, runId })).toEqual({
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
    const error = await runWorkflow({ cwd: repo.dir, workflow: 'ticket-to-pr' }).catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(JournalError);
    const [runId = ''] = readdirSync(join(repo.dir, '.sail-runs'));
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
    const end = await ran(repo.dir, { signal: controller.signal, onCall: () => controller.abort() });
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

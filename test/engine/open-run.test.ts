import { afterEach, expect, test } from 'bun:test';
import {
  appendFileSync,
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ResolvedAdapters } from '../../src/engine/adapters';
import type { Port } from '../../src/engine/config';
import { appendJournal, type NewJournalEntry, readJournal } from '../../src/engine/journal';
import { findRun, type OpenedRun, openRun, reopenRun } from '../../src/engine/open-run';
import { type Forced, readStatus, writeStatus } from '../../src/engine/run-dir';
import { type AdapterEntry, RUN_HEADER_FILE, type RunHeader, readRunHeader } from '../../src/engine/run-header';
import { ulid } from '../../src/engine/run-id';
import { validateRunDir } from '../../src/engine/schemas';
import { PortError } from '../../src/ports/errors';
import type { TicketSource } from '../../src/ports/ticket-source';
import type { TicketState } from '../../src/ports/types';
import { fakeAdapters } from '../helpers/adapters';
import { copyFixture, edit, write } from '../helpers/fixture';
import { rejection } from '../helpers/ports';
import { copyRun, writePrOnly, writeStub } from '../helpers/stub-workflow';
import { withTempRepo } from '../helpers/temp-repo';

const GOLDEN = join(import.meta.dir, '..', 'fixtures', 'runs', 'FAKE-1-01M3BWNZM08Q4T6V2XRJ5KWD3N');
const WORKFLOW = 'workflows/ticket-to-pr/workflow.ts';
const NOW = new Date('2026-09-27T09:00:00.000Z');

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Opens a run of ticket-to-pr from `cwd` on `FAKE-1`, which must not be refused. */
async function opened(cwd: string, now = NOW): Promise<OpenedRun> {
  const run = await openRun({
    cwd,
    workflow: 'ticket-to-pr',
    ticket: 'FAKE-1',
    adapters: await fakeAdapters(cwd),
    now,
  });
  if ('refused' in run) throw new Error(`refused: ${run.refused}`);
  return run;
}

/** The runs in the repository's `.sail-runs/`: every entry but `fake/`, where the fake adapters keep their state. */
const runIds = (repoDir: string): string[] =>
  existsSync(join(repoDir, '.sail-runs'))
    ? readdirSync(join(repoDir, '.sail-runs')).filter((name) => name !== 'fake')
    : [];

const sha256 = (path: string) => new Bun.CryptoHasher('sha256').update(readFileSync(path)).digest('hex');

/** A completed call of `stage`, as the engine journals it. */
const call = (stage: string, index: number): NewJournalEntry => ({
  key: `${stage}#1`,
  stage,
  call: 1,
  outcome: 'done',
  output: { ok: true },
  reason: null,
  files: {},
  resultPath: `0${index}-${stage}/call-1/result.json`,
});

test('a run opened from a subdirectory gets .sail-runs/FAKE-1-<ulid>/ with its header, an empty journal and STATUS', async () => {
  await withTempRepo(async (repo) => {
    const sail = copyFixture(repo.dir);
    const cwd = join(repo.dir, 'src', 'deep');
    mkdirSync(cwd, { recursive: true });
    const run = await opened(cwd);

    expect(run.runId).toMatch(new RegExp(`^FAKE-1-${ulid(NOW.getTime()).slice(0, 10)}[0-9A-HJKMNP-TV-Z]{16}$`));
    expect([run.sailDir, run.loaded.workflow.name]).toEqual([sail, 'ticket-to-pr']);
    expect(run.dir).toBe(join(repo.dir, '.sail-runs', run.runId));
    expect(readStatus(run.dir)).toEqual({ status: 'running' });
    expect(readJournal(run.dir)).toEqual({ entries: [], torn: false });
    expect(readFileSync(join(run.dir, 'journal.ndjson'), 'utf8')).toBe('');
    expect(run.header.runId).toBe(run.runId);
    expect(run.header.startedAt).toBe(NOW.toISOString());
    expect(validateRunDir(run.dir)).toEqual({ counts: { 'sail.run.v1': 1 }, issues: [] });
  });
});

test('run.json is byte-identical after the run journals calls and completes, and stays read-only', async () => {
  await withTempRepo(async (repo) => {
    copyFixture(repo.dir);
    const run = await opened(repo.dir);
    const path = join(run.dir, RUN_HEADER_FILE);
    const before = sha256(path);

    appendJournal(run.dir, call('spec', 1));
    appendJournal(run.dir, call('implement', 2));
    writeStatus(run.dir, 'completed');
    const reread = readRunHeader(run.dir);

    expect(sha256(path)).toBe(before);
    expect(statSync(path).mode & 0o777).toBe(0o444);
    expect(reread).toEqual(run.header);
    expect(readJournal(run.dir).entries.map((entry) => entry.key)).toEqual(['spec#1', 'implement#1']);
    expect(readStatus(run.dir)).toEqual({ status: 'completed' });
  });
});

test("the fixture's header carries the golden run's roster, workflow, adapters and budget", async () => {
  const golden: RunHeader = JSON.parse(readFileSync(join(GOLDEN, RUN_HEADER_FILE), 'utf8'));
  const [start] = readFileSync(join(GOLDEN, 'events.ndjson'), 'utf8').split('\n');
  const event: { type: string; workflow: RunHeader['workflow']; roster: Pick<RunHeader, 'intake' | 'stages'> } =
    JSON.parse(start ?? '');
  expect(event.type).toBe('run:start');
  expect(event.roster).toEqual({ intake: golden.intake, stages: golden.stages });
  expect(event.workflow).toEqual(golden.workflow);

  await withTempRepo(async (repo) => {
    copyFixture(repo.dir);
    const { header } = await opened(repo.dir);
    expect(header.stages).toEqual(golden.stages);
    expect(header.intake).toEqual(golden.intake);
    const { name, version, origin } = golden.workflow;
    expect(header.workflow).toMatchObject({ name, version, origin });
    expect(header.adapters).toEqual(golden.adapters);
    expect(header.budget).toEqual(golden.budget);
    // The same serialization the golden run.json and its run:start event were made from.
    expect(JSON.stringify(header.stages)).toBe(JSON.stringify(golden.stages));
    expect(JSON.stringify(header.stages)).toBe(JSON.stringify(event.roster.stages));
  });
});

test.each<[string, (sail: string) => void, string]>([
  [
    'an unknown workflow',
    (sail) => rmSync(join(sail, 'workflows', 'ticket-to-pr'), { recursive: true }),
    'no workflow',
  ],
  [
    'a project.yaml without adapters',
    (sail) => edit(sail, 'project.yaml', 'adapters:\n', 'no-adapters:\n'),
    '.sail/project.yaml  [sail.project.v1]  /adapters is required',
  ],
  [
    'a workflow whose declared name differs from its folder',
    (sail) => edit(sail, WORKFLOW, "'ticket-to-pr',", "'other',"),
    "declares workflow 'other', but its folder is 'ticket-to-pr'",
  ],
  [
    'a workflow reaching two stages named tests',
    (sail) => {
      cpSync(join(sail, 'stages', 'tests'), join(sail, 'workflows', 'ticket-to-pr', 'stages', 'tests'), {
        recursive: true,
      });
      edit(
        sail,
        WORKFLOW,
        "import { workflow } from 'sail';",
        "import { workflow } from 'sail';\nimport { tests as own } from './stages/tests/stage';\nexport const mine = own;",
      );
    },
    "reaches two stages named 'tests'",
  ],
])('%s is refused, and no run directory is created', async (_, breakIt, reason) => {
  await withTempRepo(async (repo) => {
    const sail = copyFixture(repo.dir);
    const adapters = await fakeAdapters(repo.dir);
    breakIt(sail);
    const run = await openRun({ cwd: repo.dir, workflow: 'ticket-to-pr', ticket: 'FAKE-1', adapters });
    expect(run).toEqual({ refused: expect.stringContaining(reason) });
    expect(existsSync(join(repo.dir, '.sail-runs'))).toBe(false);
  });
});

test('a cwd outside any git repository is refused, and nothing is created', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sail-no-repo-'));
  dirs.push(dir);
  const adapters = await withTempRepo(async (repo) => {
    copyFixture(repo.dir);
    return fakeAdapters(repo.dir);
  });
  const run = await openRun({ cwd: dir, workflow: 'ticket-to-pr', ticket: 'FAKE-1', adapters });
  expect(run).toEqual({ refused: `not inside a git repository: ${dir}` });
  expect(readdirSync(dir)).toEqual([]);
});

test('runs opened a millisecond apart sort in the order they started', async () => {
  await withTempRepo(async (repo) => {
    // One run per .sail/ in a process, so each run opens from a .sail/ of its own.
    const [first, second] = ['first', 'second'].map((name) => {
      const dir = join(repo.dir, name);
      mkdirSync(dir);
      copyFixture(dir);
      return dir;
    });
    if (first === undefined || second === undefined) throw new Error('two copies');
    const one = await opened(first, NOW);
    const two = await opened(second, new Date(NOW.getTime() + 1));
    expect(one.runId < two.runId).toBe(true);
    expect([one.runId, two.runId].sort()).toEqual([one.runId, two.runId]);
  });
});

test('a second run from one .sail/ in a process throws before it writes anything', async () => {
  await withTempRepo(async (repo) => {
    const sail = copyFixture(repo.dir);
    const first = await opened(repo.dir);
    mkdirSync(join(repo.dir, 'src'));
    const second = openRun({
      cwd: join(repo.dir, 'src'),
      workflow: 'ticket-to-pr',
      ticket: 'FAKE-1',
      adapters: await fakeAdapters(repo.dir),
    });
    await expect(second).rejects.toThrow(
      `a run from ${sail} already started in this process: Bun can't reload its modules, so each run needs a process of its own`,
    );
    expect(runIds(repo.dir)).toEqual([first.runId]);
  });
});

test('a .sail/ refused by its project.yaml is not claimed, so a run from it can open once it is fixed', async () => {
  await withTempRepo(async (repo) => {
    const sail = copyFixture(repo.dir);
    const adapters = await fakeAdapters(repo.dir);
    edit(sail, 'project.yaml', 'adapters:\n', 'no-adapters:\n');
    expect(await openRun({ cwd: repo.dir, workflow: 'ticket-to-pr', ticket: 'FAKE-1', adapters })).toEqual({
      refused: expect.any(String),
    });
    edit(sail, 'project.yaml', 'no-adapters:\n', 'adapters:\n');
    const run = await opened(repo.dir);
    expect(runIds(repo.dir)).toEqual([run.runId]);
  });
});

/** A run of the fixture opened in a repository of its own and suspended, then copied into `to` to be reopened there. */
function suspendedCopy(to: string): Promise<OpenedRun> {
  return withTempRepo(async (from) => {
    copyFixture(from.dir);
    const run = await opened(from.dir);
    writeStatus(run.dir, 'suspended', 'budget_exceeded');
    copyRun(from.dir, to);
    return run;
  });
}

test('findRun finds a suspended or running run by its id, with its header and STATUS', async () => {
  await withTempRepo(async (repo) => {
    const sail = copyFixture(repo.dir);
    const run = await opened(repo.dir);
    writeStatus(run.dir, 'suspended', 'budget_exceeded');
    expect(findRun(sail, run.runId)).toEqual({
      dir: run.dir,
      header: run.header,
      status: { status: 'suspended', stopReason: 'budget_exceeded' },
    });
    writeStatus(run.dir, 'running');
    expect(findRun(sail, run.runId)).toEqual({ dir: run.dir, header: run.header, status: { status: 'running' } });
  });
});

test.each<[string, (run: OpenedRun) => string, (runId: string) => string]>([
  [
    'a completed run',
    (run) => {
      writeStatus(run.dir, 'completed');
      return run.runId;
    },
    (runId) => `run ${runId} has completed: there is nothing to resume`,
  ],
  [
    'a failed run',
    (run) => {
      writeStatus(run.dir, 'failed', 'stage_error');
      return run.runId;
    },
    (runId) => `run ${runId} failed (stage_error): a failed run is final`,
  ],
  ['an id that names no run', () => 'FAKE-1-NOPE', () => "no run 'FAKE-1-NOPE' in .sail-runs"],
  ['an id that is not a plain name', () => '../x', () => "'../x' is not a run id"],
])('findRun refuses %s', async (_, prepare, reason) => {
  await withTempRepo(async (repo) => {
    const sail = copyFixture(repo.dir);
    const runId = prepare(await opened(repo.dir));
    expect(findRun(sail, runId)).toEqual({ refused: reason(runId) });
  });
});

test("findRun throws on a STATUS it can't read: sail's own files are broken", async () => {
  await withTempRepo(async (repo) => {
    const sail = copyFixture(repo.dir);
    const run = await opened(repo.dir);
    writeFileSync(join(run.dir, 'STATUS'), 'bogus\n');
    expect(() => findRun(sail, run.runId)).toThrow(`${join(run.dir, 'STATUS')} holds "bogus\\n"`);
  });
});

test('reopenRun reopens a suspended run with the header on disk, nothing a claim did, and STATUS running again', async () => {
  await withTempRepo(async (repo) => {
    const run = await suspendedCopy(repo.dir);
    const reopened = await reopenRun({ cwd: repo.dir, runId: run.runId, adapters: await fakeAdapters(repo.dir) });
    const dir = join(repo.dir, '.sail-runs', run.runId);
    expect(reopened).toMatchObject({
      runId: run.runId,
      dir,
      header: run.header,
      sailDir: join(repo.dir, '.sail'),
      loaded: { workflow: { name: 'ticket-to-pr' } },
      claimed: [],
    });
    expect(readStatus(dir)).toEqual({ status: 'running' });
  });
});

test('openRun creates an empty events.ndjson beside the journal, and its events start at seq 1', async () => {
  await withTempRepo(async (repo) => {
    copyFixture(repo.dir);
    const run = await opened(repo.dir);
    expect(readdirSync(run.dir).sort()).toEqual(['STATUS', 'events.ndjson', 'journal.ndjson', 'run.json']);
    expect(readFileSync(join(run.dir, 'events.ndjson'), 'utf8')).toBe('');
    expect(run.firstSeq).toBe(1);
  });
});

const eventLine = (seq: number) =>
  `${JSON.stringify({ seq, ts: NOW.toISOString(), type: 'loop:iteration', runId: 'x', loop: 'fix', iteration: seq, max: 3 })}\n`;

test.each<[string, (runDir: string) => void, number]>([
  [
    'continues from the last seq in its events file',
    (runDir) => writeFileSync(join(runDir, 'events.ndjson'), [1, 2, 3].map(eventLine).join('')),
    4,
  ],
  [
    'starts at 1 for a run opened before it had events',
    (runDir) => rmSync(join(runDir, 'events.ndjson'), { force: true }),
    1,
  ],
])('reopenRun %s', async (_, prepare, firstSeq) => {
  await withTempRepo(async (repo) => {
    const run = await suspendedCopy(repo.dir);
    prepare(join(repo.dir, '.sail-runs', run.runId));
    const reopened = await reopenRun({ cwd: repo.dir, runId: run.runId, adapters: await fakeAdapters(repo.dir) });
    if ('refused' in reopened) throw new Error(reopened.refused);
    expect(reopened.firstSeq).toBe(firstSeq);
  });
});

const ECHO: AdapterEntry = {
  use: './adapters/echo-harness.ts',
  origin: 'repo:.sail/adapters/echo-harness.ts',
  versions: { echo: '1.0.0' },
};

/** `adapters` with `entries` standing in for those it was resolved with. */
const entriesOf = (adapters: ResolvedAdapters, entries: Partial<Record<Port, AdapterEntry>>): ResolvedAdapters => ({
  ...adapters,
  entries: { ...adapters.entries, ...entries },
});

test('openRun writes the adapter entries it is handed into run.json, and hands the adapters on', async () => {
  await withTempRepo(async (repo) => {
    copyFixture(repo.dir);
    const handed = await fakeAdapters(repo.dir);
    const run = await openRun({
      cwd: repo.dir,
      workflow: 'ticket-to-pr',
      ticket: 'FAKE-1',
      adapters: entriesOf(handed, { harness: ECHO }),
    });
    if ('refused' in run) throw new Error(run.refused);
    expect(run.header.adapters.harness).toEqual(ECHO);
    expect(readRunHeader(run.dir).adapters.harness).toEqual(ECHO);
    expect(run.adapters).toBe(handed.ports);
  });
});

test('reopenRun refuses a run whose adapter changed, naming the port and both adapters, and leaves STATUS and events as they were', async () => {
  await withTempRepo(async (repo) => {
    const run = await suspendedCopy(repo.dir);
    const dir = join(repo.dir, '.sail-runs', run.runId);
    // A torn tail: only a resume that goes ahead may cut it.
    appendFileSync(join(dir, 'events.ndjson'), '{"seq":1,"ts":"2026-09-2');
    const before = ['STATUS', 'events.ndjson'].map((file) => readFileSync(join(dir, file), 'utf8'));
    const handed = await fakeAdapters(repo.dir);

    const refused = await reopenRun({
      cwd: repo.dir,
      runId: run.runId,
      adapters: entriesOf(handed, { harness: ECHO }),
    });
    expect(refused).toEqual({ refused: expect.any(String) });
    if (!('refused' in refused)) return;
    expect(refused.refused).toStartWith(`run ${run.runId} can't resume on different adapters:`);
    expect(refused.refused).toContain(
      'harness: the run started with fake (builtin), and .sail/project.yaml now names ./adapters/echo-harness.ts (repo:.sail/adapters/echo-harness.ts)',
    );
    expect(['STATUS', 'events.ndjson'].map((file) => readFileSync(join(dir, file), 'utf8'))).toEqual(before);

    // Only the versions differ: the same adapter, so the run resumes.
    const upgraded = { use: 'fake', origin: 'builtin', versions: { lib: '2.0.0' } };
    const reopened = await reopenRun({
      cwd: repo.dir,
      runId: run.runId,
      adapters: entriesOf(handed, { harness: upgraded }),
    });
    if ('refused' in reopened) throw new Error(reopened.refused);
    expect(readStatus(dir)).toEqual({ status: 'running' });
  });
});

test('reopenRun gives one line per changed port, in port order', async () => {
  await withTempRepo(async (repo) => {
    const run = await suspendedCopy(repo.dir);
    const handed = await fakeAdapters(repo.dir);
    const linear = { use: 'linear', origin: 'builtin' };
    const refused = await reopenRun({
      cwd: repo.dir,
      runId: run.runId,
      adapters: entriesOf(handed, { harness: ECHO, ticketSource: linear }),
    });
    expect(refused).toEqual({ refused: expect.any(String) });
    if (!('refused' in refused)) return;
    const [head, ...lines] = refused.refused.split('\n');
    expect(head).toBe(`run ${run.runId} can't resume on different adapters:`);
    expect(lines.map((line) => line.trim())).toEqual([
      'ticketSource: the run started with fake (builtin), and .sail/project.yaml now names linear (builtin)',
      'harness: the run started with fake (builtin), and .sail/project.yaml now names ./adapters/echo-harness.ts (repo:.sail/adapters/echo-harness.ts)',
    ]);
  });
});

test('openRun refuses agent steps that name an undefined model alias, one line per stage, and makes no run directory', async () => {
  await withTempRepo(async (repo) => {
    const sail = copyFixture(repo.dir);
    const adapters = await fakeAdapters(repo.dir);
    edit(
      sail,
      'project.yaml',
      'models: { default: claude-sonnet-5, deep: claude-opus-5-5 }',
      'models: { default: claude-sonnet-5 }',
    );
    const run = await openRun({ cwd: repo.dir, workflow: 'ticket-to-pr', ticket: 'FAKE-1', adapters });
    expect(run).toEqual({
      refused: [
        "stage 'self-review' names the model alias 'deep', which .sail/project.yaml's models doesn't define",
        "stage 'spec' names the model alias 'deep', which .sail/project.yaml's models doesn't define",
      ].join('\n'),
    });
    expect(existsSync(join(repo.dir, '.sail-runs'))).toBe(false);
  });
});

// What openRun() refuses of a workflow before the ticket is touched, and reopenRun() before STATUS changes.

/** An intake of the repository's own, in a file of its own. */
const OWN_INTAKE =
  "import { intake, z } from 'sail';\n" +
  "export const own = intake('own', { accepts: ['ticket'], output: z.object({ ticketKey: z.string() }) });\n";

/** Gives the fixture's ticket-to-pr an intake of the repository's own in place of the built-in. */
function useOwnIntake(sail: string): void {
  write(sail, 'workflows/ticket-to-pr/intake.ts', OWN_INTAKE);
  edit(sail, WORKFLOW, "import { ticket } from 'sail/intakes';", "import { own as ticket } from './intake';");
}

test('openRun refuses a workflow that names an intake of its own, which accepts tickets: only a built-in intake runs', async () => {
  await withTempRepo(async (repo) => {
    useOwnIntake(copyFixture(repo.dir));
    const run = await openRun({
      cwd: repo.dir,
      workflow: 'ticket-to-pr',
      ticket: 'FAKE-1',
      adapters: await fakeAdapters(repo.dir),
    });
    expect(run).toEqual({
      refused:
        ".sail/workflows/ticket-to-pr/workflow.ts: its intake 'own' is the repository's own, and only a built-in intake runs",
    });
    expect(existsSync(join(repo.dir, '.sail-runs'))).toBe(false);
  });
});

test("openRun refuses a workflow that reaches a stage named intake: its first call's key would be the intake's", async () => {
  await withTempRepo(async (repo) => {
    const sail = copyFixture(repo.dir);
    write(
      sail,
      'stages/intake/stage.ts',
      "import { script, z } from 'sail';\nexport const intake = script('intake', { run: './run.sh', output: z.object({ ok: z.boolean() }) });\n",
    );
    edit(
      sail,
      WORKFLOW,
      "import { tests } from '../../stages/tests/stage';",
      "import { intake as fetch } from '../../stages/intake/stage';\nimport { tests } from '../../stages/tests/stage';\nvoid fetch;",
    );
    const run = await openRun({
      cwd: repo.dir,
      workflow: 'ticket-to-pr',
      ticket: 'FAKE-1',
      adapters: await fakeAdapters(repo.dir),
    });
    expect(run).toEqual({
      refused:
        ".sail/stages/intake/stage.ts: a stage can't be named 'intake': its first call's key would be the intake's, intake#1",
    });
    expect(existsSync(join(repo.dir, '.sail-runs'))).toBe(false);
  });
});

test('reopenRun refuses a workflow that has come to reach a stage named intake, and leaves STATUS and a torn events tail as they were', async () => {
  await withTempRepo(async (repo) => {
    const run = await suspendedCopy(repo.dir);
    const dir = join(repo.dir, '.sail-runs', run.runId);
    // A torn tail, and a refusal that comes once the workflow is loaded: only a resume that goes ahead may cut it.
    appendFileSync(join(dir, 'events.ndjson'), '{"seq":1,"ts":"2026-09-2');
    const before = ['STATUS', 'events.ndjson'].map((file) => readFileSync(join(dir, file), 'utf8'));
    const sail = join(repo.dir, '.sail');
    write(
      sail,
      'stages/intake/stage.ts',
      "import { script, z } from 'sail';\nexport const intake = script('intake', { run: './run.sh', output: z.object({ ok: z.boolean() }) });\n",
    );
    edit(
      sail,
      WORKFLOW,
      "import { tests } from '../../stages/tests/stage';",
      "import { intake as fetch } from '../../stages/intake/stage';\nimport { tests } from '../../stages/tests/stage';\nvoid fetch;",
    );
    const reopened = await reopenRun({ cwd: repo.dir, runId: run.runId, adapters: await fakeAdapters(repo.dir) });
    expect(reopened).toEqual({
      refused:
        ".sail/stages/intake/stage.ts: a stage can't be named 'intake': its first call's key would be the intake's, intake#1",
    });
    expect(before[0]).toBe('suspended budget_exceeded\n');
    expect(['STATUS', 'events.ndjson'].map((file) => readFileSync(join(dir, file), 'utf8'))).toEqual(before);
  });
});

// A run from a ticket (D7, D8, D9), on the stub: what openRun() checks of the ticket, and the claim it makes before
// the run directory exists.

const IN_PROGRESS: TicketState = { type: 'started', name: 'In Progress' };
const ULID = '[0-9A-HJKMNP-TV-Z]{26}';
/** Where the fake TicketSource keeps what changed: the file exists only once a ticket was written to. */
const stateFile = (repoDir: string) => join(repoDir, '.sail-runs', 'fake', 'tickets.json');

interface StubRun {
  ticket: string;
  workflow?: string;
  force?: boolean;
  until?: string;
  signal?: AbortSignal;
}

/** Opens a run of the stub from `repoDir`, on the adapters given or its own. */
async function openStub(repoDir: string, run: StubRun, adapters?: ResolvedAdapters) {
  return openRun({
    cwd: repoDir,
    workflow: 'ticket-to-pr',
    now: NOW,
    ...run,
    adapters: adapters ?? (await fakeAdapters(repoDir)),
  });
}

/** The ticket as the repository's fake holds it now. */
async function ticketIn(repoDir: string, ticketKey: string) {
  return (await fakeAdapters(repoDir)).ports.ticketSource.get(ticketKey);
}

/** The repository's adapters, with `instead` answering in place of the ticket source's own `op`. */
async function adaptersWith<Op extends 'claim' | 'comment'>(
  repoDir: string,
  op: Op,
  instead: (own: TicketSource[Op]) => TicketSource[Op],
): Promise<ResolvedAdapters> {
  const adapters = await fakeAdapters(repoDir);
  const { ticketSource } = adapters.ports;
  ticketSource[op] = instead(ticketSource[op].bind(ticketSource) as TicketSource[Op]);
  return adapters;
}

test('openRun from a ticket claims it before the run directory exists: run.json holds the source with nothing forced and the claim, and the ticket is In Progress with a comment naming the run', async () => {
  await withTempRepo(async (repo) => {
    writeStub(repo.dir);
    const runsAtComment: string[][] = [];
    const adapters = await adaptersWith(repo.dir, 'comment', (comment) => (ticketKey, body) => {
      runsAtComment.push(runIds(repo.dir));
      return comment(ticketKey, body);
    });
    const run = await openStub(repo.dir, { ticket: 'FAKE-1' }, adapters);
    if ('refused' in run) throw new Error(run.refused);

    expect(run.runId).toMatch(new RegExp(`^FAKE-1-${ULID}$`));
    const body = `sail run ${run.runId} started`;
    const header = readRunHeader(run.dir);
    expect([header.source, header.claim]).toEqual([
      { kind: 'ticket', ticketKey: 'FAKE-1', via: 'cli', forced: [] },
      { claimed: true, state: IN_PROGRESS },
    ]);
    expect(run.header).toEqual(header);
    expect(run.claimed).toEqual([
      { type: 'ticket:claimed', ticketKey: 'FAKE-1', state: IN_PROGRESS },
      { type: 'ticket:commented', ticketKey: 'FAKE-1', body },
    ]);
    const ticket = await ticketIn(repo.dir, 'FAKE-1');
    expect([ticket.state, ticket.comments.at(-1)?.body]).toEqual([IN_PROGRESS, body]);
    expect([runsAtComment, runIds(repo.dir)]).toEqual([[[]], [run.runId]]);
  });
});

test('a URL the ticket source owns opens the run of the ticket it names', async () => {
  await withTempRepo(async (repo) => {
    writeStub(repo.dir);
    const run = await openStub(repo.dir, { ticket: 'fake://tickets/FAKE-1' });
    expect(run).toMatchObject({
      runId: expect.stringMatching(new RegExp(`^FAKE-1-${ULID}$`)),
      header: { source: { ticketKey: 'FAKE-1' } },
    });
    expect((await ticketIn(repo.dir, 'FAKE-1')).state).toEqual(IN_PROGRESS);
  });
});

const PR_ONLY = ".sail/workflows/pr-only/workflow.ts: its intake 'pull-request' accepts pr";

test.each<[string, StubRun, string]>([
  [
    "an intake of the repository's own that accepts only pull requests, for what it accepts",
    { ticket: 'FAKE-1', workflow: 'pr-only' },
    `${PR_ONLY}, and FAKE-1 is a ticket`,
  ],
  [
    'an intake that accepts only pull requests, before the ticket source is asked about the key',
    { ticket: 'FAKE1', workflow: 'pr-only' },
    `${PR_ONLY}, and FAKE1 is a ticket`,
  ],
  [
    'a key the ticket source does not parse',
    { ticket: 'FAKE1' },
    "'FAKE1' is not a ticket of the fake ticket source: a ticket key, or a URL it owns",
  ],
  ['a ticket the ticket source does not have', { ticket: 'FAKE-9' }, 'ticketSource.get: no ticket FAKE-9 (not_found)'],
  [
    'a ticket without the label',
    { ticket: 'FAKE-3' },
    "the ticket is not designated: it carries no 'sail' label. --force runs it anyway",
  ],
  [
    'a ticket that is In Progress',
    { ticket: 'FAKE-4' },
    'the ticket is already claimed: it is In Progress. --force runs it anyway',
  ],
])('%s is refused, with no run directory and the ticket never written to', async (_, run, refused) => {
  await withTempRepo(async (repo) => {
    writePrOnly(writeStub(repo.dir));
    expect([await openStub(repo.dir, run), existsSync(join(repo.dir, '.sail-runs'))]).toEqual([{ refused }, false]);
  });
});

test.each<[string, string, Forced[], boolean, string]>([
  ['an undesignated ticket', 'FAKE-3', ['designation'], true, 'ticket:claimed'],
  ['a started ticket', 'FAKE-4', ['state'], false, 'ticket:updated'],
  ['an undesignated, completed ticket', 'FAKE-5', ['designation', 'state'], false, 'ticket:updated'],
])(
  'forced, %s opens: the header lists what --force overrode and whether the claim took, and the ticket is In Progress with the comment',
  async (_, ticket, forced, claimed, moved) => {
    await withTempRepo(async (repo) => {
      writeStub(repo.dir);
      const run = await openStub(repo.dir, { ticket, force: true });
      if ('refused' in run) throw new Error(run.refused);
      expect([run.header.source, run.header.claim, run.claimed.map((event): string => event.type)]).toEqual([
        { kind: 'ticket', ticketKey: ticket, via: 'cli', forced },
        { claimed, state: IN_PROGRESS },
        [moved, 'ticket:commented'],
      ]);
      expect(readRunHeader(run.dir)).toEqual(run.header);
      const now = await ticketIn(repo.dir, ticket);
      expect([now.state, now.comments.at(-1)?.body]).toEqual([IN_PROGRESS, `sail run ${run.runId} started`]);
    });
  },
);

/** Adapters whose claim loses a race: another start, on a fake of its own over the same state, claims first. */
async function racing(repoDir: string): Promise<ResolvedAdapters> {
  const other = (await fakeAdapters(repoDir)).ports.ticketSource;
  return adaptersWith(repoDir, 'claim', (claim) => async (ticketKey) => {
    await other.claim(ticketKey);
    return claim(ticketKey);
  });
}

test('a claim that does not take, for a ticket the fetch showed unstarted, is refused with no run directory', async () => {
  await withTempRepo(async (repo) => {
    writeStub(repo.dir);
    const run = await openStub(repo.dir, { ticket: 'FAKE-1' }, await racing(repo.dir));
    expect([run, runIds(repo.dir)]).toEqual([
      {
        refused: 'the ticket is already claimed: it became In Progress while sail was starting. --force runs it anyway',
      },
      [],
    ]);
    expect((await ticketIn(repo.dir, 'FAKE-1')).comments.map((comment) => comment.author)).toEqual(['stub-user']);
  });
});

test('forced, a claim that does not take opens the run, which records the state check as the one overridden', async () => {
  await withTempRepo(async (repo) => {
    writeStub(repo.dir);
    const run = await openStub(repo.dir, { ticket: 'FAKE-1', force: true }, await racing(repo.dir));
    expect(run).toMatchObject({
      header: { source: { forced: ['state'] }, claim: { claimed: false, state: IN_PROGRESS } },
      claimed: [{ type: 'ticket:updated' }, { type: 'ticket:commented' }],
    });
  });
});

test('a comment that fails once the ticket has moved is refused, naming the state it is in and the run, with no run directory', async () => {
  await withTempRepo(async (repo) => {
    writeStub(repo.dir);
    const adapters = await adaptersWith(repo.dir, 'comment', () => async () => {
      throw new PortError('ticketSource', 'comment', 'unavailable', 'comments are closed');
    });
    const run = await openStub(repo.dir, { ticket: 'FAKE-1' }, adapters);
    expect(run).toEqual({
      refused: expect.stringMatching(
        new RegExp(
          `^the ticket is now In Progress, but the comment naming run FAKE-1-${ULID} failed: ticketSource\\.comment: comments are closed \\(unavailable\\)\\. --force runs it$`,
        ),
      ),
    });
    expect([runIds(repo.dir), (await ticketIn(repo.dir, 'FAKE-1')).state]).toEqual([[], IN_PROGRESS]);
  });
});

test("a claim whose answer carries more than the state's type and name opens the run, and run.json holds those two", async () => {
  await withTempRepo(async (repo) => {
    writeStub(repo.dir);
    const adapters = await adaptersWith(repo.dir, 'claim', (claim) => async (ticketKey) => {
      const answer = await claim(ticketKey);
      return { ...answer, state: Object.assign({ id: 'state-7' }, answer.state) };
    });
    const run = await openStub(repo.dir, { ticket: 'FAKE-1' }, adapters);
    if ('refused' in run) throw new Error(run.refused);
    expect(readRunHeader(run.dir).claim).toEqual({ claimed: true, state: IN_PROGRESS });
    expect(validateRunDir(run.dir).issues).toEqual([]);
  });
});

test('a run directory that cannot be written once the ticket has moved throws, naming the state it is in and the run its comment names', async () => {
  await withTempRepo(async (repo) => {
    writeStub(repo.dir);
    const runs = join(repo.dir, '.sail-runs');
    // Read-only once the comment is posted: the fake has written its state by then, and only the run is left to make.
    const adapters = await adaptersWith(repo.dir, 'comment', (comment) => async (ticketKey, body) => {
      const posted = await comment(ticketKey, body);
      chmodSync(runs, 0o555);
      return posted;
    });
    const thrown = await rejection(openStub(repo.dir, { ticket: 'FAKE-1' }, adapters)).finally(() =>
      chmodSync(runs, 0o755),
    );
    expect(thrown).toMatchObject({
      message: expect.stringMatching(
        new RegExp(
          `^the ticket is now In Progress and its comment names run FAKE-1-${ULID}, but the run directory was not written: EACCES.+\\. --force runs the ticket in a new run$`,
        ),
      ),
      cause: { code: 'EACCES' },
    });
    const ticket = await ticketIn(repo.dir, 'FAKE-1');
    expect([runIds(repo.dir), ticket.state, ticket.comments.at(-1)?.body]).toEqual([
      [],
      IN_PROGRESS,
      expect.stringMatching(new RegExp(`^sail run FAKE-1-${ULID} started$`)),
    ]);
  });
});

// An abort: seen before the claim it ends the start with the ticket as it was, and once the ticket is claimed the start
// goes on to its comment and its run directory, for the run to be suspended there.

test.each<[string, (source: TicketSource, abort: () => void) => void]>([
  ['before the start', (_, abort) => abort()],
  [
    'while the ticket is fetched',
    (source, abort) => {
      const get = source.get.bind(source);
      source.get = async (ticketKey) => {
        abort();
        return get(ticketKey);
      };
    },
  ],
])(
  'an abort seen %s is refused before the claim, with no run directory and the ticket never written to',
  async (_, arrange) => {
    await withTempRepo(async (repo) => {
      writeStub(repo.dir);
      const adapters = await fakeAdapters(repo.dir);
      const controller = new AbortController();
      arrange(adapters.ports.ticketSource, () => controller.abort());
      const run = await openStub(repo.dir, { ticket: 'FAKE-1', signal: controller.signal }, adapters);
      expect([run, existsSync(join(repo.dir, '.sail-runs'))]).toEqual([
        { refused: 'stopped before the ticket was claimed' },
        false,
      ]);
    });
  },
);

test('an abort seen once the ticket is claimed still comments and opens the run', async () => {
  await withTempRepo(async (repo) => {
    writeStub(repo.dir);
    const controller = new AbortController();
    const adapters = await adaptersWith(repo.dir, 'claim', (claim) => async (ticketKey) => {
      const result = await claim(ticketKey);
      controller.abort();
      return result;
    });
    const run = await openStub(repo.dir, { ticket: 'FAKE-1', signal: controller.signal }, adapters);
    if ('refused' in run) throw new Error(run.refused);
    const ticket = await ticketIn(repo.dir, 'FAKE-1');
    expect([runIds(repo.dir), ticket.state, ticket.comments.at(-1)?.body]).toEqual([
      [run.runId],
      IN_PROGRESS,
      `sail run ${run.runId} started`,
    ]);
  });
});

test("the label checked is project.yaml's, and sail's own when it sets none", async () => {
  const refusedFor = (ticket: string, label: string) =>
    withTempRepo(async (repo) => {
      edit(writeStub(repo.dir), 'project.yaml', 'label: sail\n', label);
      return openStub(repo.dir, { ticket });
    });
  expect([await refusedFor('FAKE-1', 'label: sail-api\n'), await refusedFor('FAKE-3', '')]).toEqual([
    { refused: "the ticket is not designated: it carries no 'sail-api' label. --force runs it anyway" },
    { refused: "the ticket is not designated: it carries no 'sail' label. --force runs it anyway" },
  ]);
});

test('a header that breaks sail.run.v1 throws once the ticket is fetched and before it is claimed', async () => {
  await withTempRepo(async (repo) => {
    writeStub(repo.dir);
    const adapters = await fakeAdapters(repo.dir);
    const { ticketSource } = adapters.ports;
    const calls: string[] = [];
    for (const op of ['get', 'claim', 'update', 'comment'] as const) {
      const own = ticketSource[op].bind(ticketSource) as (...args: unknown[]) => Promise<unknown>;
      (ticketSource as unknown as Record<string, unknown>)[op] = (...args: unknown[]) => {
        calls.push(op);
        return own(...args);
      };
    }
    const broken = entriesOf(adapters, { harness: { use: 'fake', origin: 'nowhere' } });
    const thrown = await rejection(openStub(repo.dir, { ticket: 'FAKE-1' }, broken));
    expect(String(thrown)).toContain('run.json breaks sail.run.v1, a bug in sail:');
    expect([calls, existsSync(stateFile(repo.dir))]).toEqual([['get'], false]);
  });
});

// --until (D10): a stage the roster doesn't hold is refused before the ticket is asked for.

const NO_STAGE =
  "which is no stage of workflow 'ticket-to-pr': its stages are implement, publish, self-review, spec, tests";

test.each<[string, StubRun, string]>([
  ['a name that is no stage', { ticket: 'FAKE-1', until: 'nope' }, `--until names 'nope', ${NO_STAGE}`],
  ['the intake, which is no stage', { ticket: 'FAKE-1', until: 'intake' }, `--until names 'intake', ${NO_STAGE}`],
  [
    'a name that is no stage, before a ticket that is not designated',
    { ticket: 'FAKE-3', until: 'nope' },
    `--until names 'nope', ${NO_STAGE}`,
  ],
])('--until with %s is refused, with no run directory and the ticket never written to', async (_, run, refused) => {
  await withTempRepo(async (repo) => {
    writeStub(repo.dir);
    expect([await openStub(repo.dir, run), existsSync(join(repo.dir, '.sail-runs'))]).toEqual([{ refused }, false]);
  });
});

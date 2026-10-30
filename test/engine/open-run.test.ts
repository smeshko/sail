import { afterEach, expect, test } from 'bun:test';
import {
  appendFileSync,
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
import { validateRunDir } from '../../src/engine/schemas';
import { PortError } from '../../src/ports/errors';
import type { TicketSource } from '../../src/ports/ticket-source';
import type { WorkspacePort } from '../../src/ports/workspace';
import { fakeAdapters } from '../helpers/adapters';
import { GOLDEN_START, GOLDEN_STEP_MS, goldenRandom, steppingClock } from '../helpers/clock';
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
    clock: () => now,
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

    // Which reading of its clock the id and startedAt are has a case of its own.
    expect(run.runId).toMatch(/^FAKE-1-[0-9A-HJKMNP-TV-Z]{26}$/);
    expect([run.sailDir, run.loaded.workflow.name]).toEqual([sail, 'ticket-to-pr']);
    expect(run.dir).toBe(join(repo.dir, '.sail-runs', run.runId));
    expect(readStatus(run.dir)).toEqual({ status: 'running' });
    expect(readJournal(run.dir)).toEqual({ entries: [], torn: false });
    expect(readFileSync(join(run.dir, 'journal.ndjson'), 'utf8')).toBe('');
    expect(run.header.runId).toBe(run.runId);
    expect(run.header.startedAt).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
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
  [
    'a model alias naming a harness adapters.harnesses does not define',
    (sail) => nameHarness(sail, 'codex', 'gpt-5.5'),
    ".sail/project.yaml  /models/deep/harness names the harness 'codex', which adapters.harnesses doesn't define",
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

test('reopenRun reopens a suspended run with the header on disk and STATUS running again', async () => {
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
    });
    expect(readStatus(dir)).toEqual({ status: 'running' });
  });
});

test.each(['workspace reopen', 'unreadable events'])(
  'a refused resume after %s marks its renewed lease as held by no process',
  async (failure) => {
    await withTempRepo(async (repo) => {
      const run = await suspendedCopy(repo.dir);
      const dir = join(repo.dir, '.sail-runs', run.runId);
      const adapters = await fakeAdapters(repo.dir);
      if (failure === 'workspace reopen') {
        adapters.ports.workspace.reopen = async () => {
          throw new PortError('workspace', 'reopen', 'unavailable', 'workspace unavailable');
        };
      } else {
        writeFileSync(join(dir, 'events.ndjson'), 'invalid json\n');
      }
      const result = await reopenRun({ cwd: repo.dir, runId: run.runId, adapters });
      expect(result).toHaveProperty('refused');
      expect(readStatus(dir)).toEqual({ status: 'suspended', stopReason: 'budget_exceeded' });
      const { branch, repository } = run.header;
      if (branch === undefined || repository === undefined) throw new Error('the run header names no branch');
      expect(await adapters.ports.workspace.holder(repository.url, branch)).toMatchObject({ suspended: true });
      // A different process can renew even while this resume's pid is still alive.
      expect(
        await adapters.ports.workspace.lease(repository.url, branch, {
          runId: run.runId,
          runDir: dir,
          pid: process.ppid,
        }),
      ).toMatchObject({ leased: true });
    });
  },
);

test('a still-running refusal from an adapter that names no lease file says to remove its lease', async () => {
  await withTempRepo(async (repo) => {
    const run = await suspendedCopy(repo.dir);
    const pid = process.ppid;
    const adapters = await workspaceWith(repo.dir, 'lease', () => async (remote, branch, holder) => ({
      leased: false,
      holder: { ...holder, remote, branch, pid, takenAt: NOW.toISOString() },
      raw: null,
    }));
    expect(await reopenRun({ cwd: repo.dir, runId: run.runId, adapters })).toEqual({
      refused: `run ${run.runId} is still running, in process ${pid}: stop it before resuming it. If process ${pid} is not sail, it took the pid of the run's ended process: remove its lease, then resume it`,
    });
  });
});

test('reopenRun whose lease throws is refused, and leaves STATUS, the events and the leases as they were', async () => {
  await withTempRepo(async (repo) => {
    const run = await suspendedCopy(repo.dir);
    const dir = join(repo.dir, '.sail-runs', run.runId);
    const events = readFileSync(join(dir, 'events.ndjson'), 'utf8');
    const adapters = await workspaceWith(repo.dir, 'lease', () => async () => {
      throw new PortError('workspace', 'lease', 'unavailable', 'leases are down');
    });
    const leases = join(repo.dir, '.sail-runs', 'fake', 'leases');
    const leasesBefore = existsSync(leases) ? readdirSync(leases) : [];

    expect(await reopenRun({ cwd: repo.dir, runId: run.runId, adapters })).toEqual({
      refused: `the branch ${run.header.branch} could not be leased: workspace.lease: leases are down (unavailable)`,
    });
    expect({
      status: readStatus(dir),
      events: readFileSync(join(dir, 'events.ndjson'), 'utf8'),
      leases: existsSync(leases) ? readdirSync(leases) : [],
    }).toEqual({ status: { status: 'suspended', stopReason: 'budget_exceeded' }, events, leases: leasesBefore });
  });
});

test('reopenRun on a run a stop ended while it took the lease, whose release then fails, is refused naming the lease left behind, which is stale', async () => {
  await withTempRepo(async (repo) => {
    const run = await suspendedCopy(repo.dir);
    const dir = join(repo.dir, '.sail-runs', run.runId);
    const adapters = await workspaceWith(repo.dir, 'lease', (lease) => (...args) => {
      writeStatus(dir, 'failed', 'stopped');
      return lease(...args);
    });
    adapters.ports.workspace.releaseLease = async () => {
      throw new PortError('workspace', 'releaseLease', 'unavailable', 'leases are down');
    };

    expect(await reopenRun({ cwd: repo.dir, runId: run.runId, adapters })).toEqual({
      refused: `run ${run.runId} failed (stopped): a failed run is final, and its lease on ${run.header.branch} was not released: workspace.releaseLease: leases are down (unavailable)`,
    });
    expect(readStatus(dir)).toEqual({ status: 'failed', stopReason: 'stopped' });
    expect(readdirSync(join(repo.dir, '.sail-runs', 'fake', 'leases'))).toHaveLength(1);

    const other = await fakeAdapters(repo.dir);
    const { branch, repository } = run.header;
    if (branch === undefined || repository === undefined) throw new Error('the run header names no branch');
    const taken = await other.ports.workspace.lease(repository.url, branch, {
      runId: 'FAKE-1-01M3BWNZM08Q4T6V2XRJ5KWD3N',
      runDir: join(repo.dir, '.sail-runs', 'FAKE-1-01M3BWNZM08Q4T6V2XRJ5KWD3N'),
      pid: process.pid,
    });
    expect(taken).toMatchObject({ leased: true });
  });
});

test('openRun creates an empty events.ndjson beside the journal, and its events start at seq 1', async () => {
  await withTempRepo(async (repo) => {
    copyFixture(repo.dir);
    const run = await opened(repo.dir);
    expect(readdirSync(run.dir).sort()).toEqual([
      'STATUS',
      'definition',
      'events.ndjson',
      'journal.ndjson',
      'run.json',
      'workspace',
    ]);
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

test('openRun refuses a workflow that names an intake of its own with no steps, naming the intake.ts', async () => {
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
        ".sail/workflows/ticket-to-pr/intake.ts: intake 'own' has no steps: only a built-in intake runs without them",
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

// A run from a ticket (D7, D8, D9), on the stub: what openRun() checks of the ticket. It claims nothing: the intake does.

const ULID = '[0-9A-HJKMNP-TV-Z]{26}';
/** Where the fake TicketSource keeps what changed: the file exists only once a ticket was written to. */
const stateFile = (repoDir: string) => join(repoDir, '.sail-runs', 'fake', 'tickets.json');

interface StubRun {
  ticket: string;
  workflow?: string;
  force?: boolean;
  until?: string;
  signal?: AbortSignal;
  dispatch?: { runId: string };
  headSha?: string;
}

/** Opens a run of the stub from `repoDir`, on the adapters given or its own. */
async function openStub(repoDir: string, run: StubRun, adapters?: ResolvedAdapters) {
  return openRun({
    cwd: repoDir,
    workflow: 'ticket-to-pr',
    clock: () => NOW,
    ...run,
    adapters: adapters ?? (await fakeAdapters(repoDir)),
  });
}

/** The ticket as the repository's fake holds it now. */
async function ticketIn(repoDir: string, ticketKey: string) {
  return (await fakeAdapters(repoDir)).ports.ticketSource.get(ticketKey);
}

/** The repository's adapters, with `instead` answering in place of the Workspace port's own `op`. */
async function workspaceWith<Op extends 'lease' | 'releaseLease'>(
  repoDir: string,
  op: Op,
  instead: (own: WorkspacePort[Op]) => WorkspacePort[Op],
): Promise<ResolvedAdapters> {
  const adapters = await fakeAdapters(repoDir);
  const { workspace } = adapters.ports;
  workspace[op] = instead(workspace[op].bind(workspace) as WorkspacePort[Op]);
  return adapters;
}

test('openRun from a ticket leaves the ticket as it was: run.json holds the source with nothing forced and no claim, the ticket is still Todo, and no comment names the run', async () => {
  await withTempRepo(async (repo) => {
    writeStub(repo.dir);
    const before = await ticketIn(repo.dir, 'FAKE-1');
    const run = await openStub(repo.dir, { ticket: 'FAKE-1' });
    if ('refused' in run) throw new Error(run.refused);

    expect(run.runId).toMatch(new RegExp(`^FAKE-1-${ULID}$`));
    const header = readRunHeader(run.dir);
    expect(header.source).toEqual({ kind: 'ticket', ticketKey: 'FAKE-1', via: 'cli', forced: [] });
    expect('claim' in header).toBe(false);
    expect(run.header).toEqual(header);
    expect(await ticketIn(repo.dir, 'FAKE-1')).toEqual(before);
    expect(runIds(repo.dir)).toEqual([run.runId]);
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
    expect((await ticketIn(repo.dir, 'FAKE-1')).state.type).toBe('unstarted');
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

test('a ref neither adapter reads, for an intake that takes no ticket, is refused naming both adapters, with no run directory', async () => {
  await withTempRepo(async (repo) => {
    writePrOnly(writeStub(repo.dir));
    const refused =
      "'FAKE1' is neither a ticket of the fake ticket source (a ticket key, or a URL it owns) nor a pull request of the fake code host (#<number>, or its URL)";
    const run = await openStub(repo.dir, { ticket: 'FAKE1', workflow: 'pr-only' });
    expect([run, existsSync(join(repo.dir, '.sail-runs'))]).toEqual([{ refused }, false]);
  });
});

test.each<[string, string, Forced[]]>([
  ['an undesignated ticket', 'FAKE-3', ['designation']],
  ['a started ticket', 'FAKE-4', ['state']],
  ['an undesignated, completed ticket', 'FAKE-5', ['designation', 'state']],
])(
  'forced, %s opens: the header lists what --force overrode, and the ticket is left as it was',
  async (_, ticket, forced) => {
    await withTempRepo(async (repo) => {
      writeStub(repo.dir);
      const before = await ticketIn(repo.dir, ticket);
      const run = await openStub(repo.dir, { ticket, force: true });
      if ('refused' in run) throw new Error(run.refused);
      expect([run.header.source, run.header.claim]).toEqual([
        { kind: 'ticket', ticketKey: ticket, via: 'cli', forced },
        undefined,
      ]);
      expect(readRunHeader(run.dir)).toEqual(run.header);
      expect(await ticketIn(repo.dir, ticket)).toEqual(before);
    });
  },
);

test('opening a run never calls the ticket source to claim, update or comment', async () => {
  await withTempRepo(async (repo) => {
    writeStub(repo.dir);
    const adapters = await fakeAdapters(repo.dir);
    const { ticketSource } = adapters.ports;
    const calls: string[] = [];
    for (const op of ['claim', 'update', 'comment'] as const) {
      const own = ticketSource[op].bind(ticketSource) as (...args: unknown[]) => Promise<unknown>;
      (ticketSource as unknown as Record<string, unknown>)[op] = (...args: unknown[]) => {
        calls.push(op);
        return own(...args);
      };
    }
    const run = await openStub(repo.dir, { ticket: 'FAKE-1' }, adapters);
    if ('refused' in run) throw new Error(run.refused);
    expect([calls, existsSync(stateFile(repo.dir))]).toEqual([[], false]);
  });
});

// An abort seen before the run is opened ends the start with the ticket as it was.

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
  'an abort seen %s is refused before the run is opened, with no run directory and the ticket never written to',
  async (_, arrange) => {
    await withTempRepo(async (repo) => {
      writeStub(repo.dir);
      const adapters = await fakeAdapters(repo.dir);
      const controller = new AbortController();
      arrange(adapters.ports.ticketSource, () => controller.abort());
      const run = await openStub(repo.dir, { ticket: 'FAKE-1', signal: controller.signal }, adapters);
      expect([run, existsSync(join(repo.dir, '.sail-runs'))]).toEqual([
        { refused: 'stopped before the run was opened' },
        false,
      ]);
    });
  },
);

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

test("openRun reads its clock before anything else does: the run id's time and startedAt are its first reading, and the id's random part is the bytes it is given", async () => {
  await withTempRepo(async (repo) => {
    writeStub(repo.dir);
    // The fakes read the same clock, twice for the fetch that comes before the id is minted.
    const clock = steppingClock(GOLDEN_START, GOLDEN_STEP_MS);
    const run = await openRun({
      cwd: repo.dir,
      workflow: 'ticket-to-pr',
      ticket: 'FAKE-1',
      adapters: await fakeAdapters(repo.dir, {}, { now: clock }),
      clock,
      random: goldenRandom,
    });
    if ('refused' in run) throw new Error(`refused: ${run.refused}`);
    expect(run.runId).toBe('FAKE-1-01M3BWNZM08Q4T6V2XRJ5KWD3N');
    expect(run.header.startedAt).toBe(GOLDEN_START);
    expect(clock.readings.length).toBeGreaterThan(1);
  });
});

test('without random bytes, two runs opened at the same reading get different ids on that reading', async () => {
  await withTempRepo(async (repo) => {
    const [first, second] = ['first', 'second'].map((name) => {
      const dir = join(repo.dir, name);
      mkdirSync(dir);
      writeStub(dir);
      return dir;
    });
    if (first === undefined || second === undefined) throw new Error('two copies');
    const [one, two] = [await opened(first, new Date(GOLDEN_START)), await opened(second, new Date(GOLDEN_START))];
    expect([one.runId.slice(0, 17), two.runId.slice(0, 17)]).toEqual(['FAKE-1-01M3BWNZM0', 'FAKE-1-01M3BWNZM0']);
    expect(one.runId).not.toBe(two.runId);
  });
});

// A dispatched start (DECISIONS D2-D4): the run the watcher spawned, under the run id it minted.

const DISPATCHED = 'FAKE-1-01M3BWNZM08Q4T6V2XRJ5KWD3N';

/** What a refused start left: the runs, the leases the fake holds, and the ticket's state and comments. */
async function leftBehind(repoDir: string, ticketKey = 'FAKE-1') {
  const leases = join(repoDir, '.sail-runs', 'fake', 'leases');
  const ticket = await ticketIn(repoDir, ticketKey);
  return {
    runs: runIds(repoDir),
    leases: existsSync(leases) ? readdirSync(leases) : [],
    state: ticket.state.name,
    comments: ticket.comments.length,
  };
}

test('a dispatched start runs under the run id it is given, and records its source via watch, with no claim', async () => {
  await withTempRepo(async (repo) => {
    writeStub(repo.dir);
    const run = await openStub(repo.dir, { ticket: 'FAKE-1', dispatch: { runId: DISPATCHED } });
    if ('refused' in run) throw new Error(run.refused);
    expect([run.runId, run.dir]).toEqual([DISPATCHED, join(repo.dir, '.sail-runs', DISPATCHED)]);
    const header = readRunHeader(run.dir);
    expect([header.runId, header.source, header.claim]).toEqual([
      DISPATCHED,
      { kind: 'ticket', ticketKey: 'FAKE-1', via: 'watch', forced: [] },
      undefined,
    ]);
    expect(await leftBehind(repo.dir)).toMatchObject({ state: 'Todo', comments: 1 });
  });
});

test.each<[string, StubRun, string]>([
  [
    "another ticket's run id",
    { ticket: 'FAKE-1', dispatch: { runId: 'FAKE-2-01M3BWNZM08Q4T6V2XRJ5KWD3N' } },
    "--dispatch takes the id of a new run of FAKE-1, FAKE-1-<26 Crockford characters>: 'FAKE-2-01M3BWNZM08Q4T6V2XRJ5KWD3N' is not one",
  ],
  [
    'a run id that is no ULID',
    { ticket: 'FAKE-1', dispatch: { runId: 'FAKE-1-01M3BWNZM08Q4T6V2XRJ5KWD3' } },
    "--dispatch takes the id of a new run of FAKE-1, FAKE-1-<26 Crockford characters>: 'FAKE-1-01M3BWNZM08Q4T6V2XRJ5KWD3' is not one",
  ],
  [
    'a run id with a letter Crockford leaves out',
    { ticket: 'FAKE-1', dispatch: { runId: 'FAKE-1-01M3BWNZM08Q4T6V2XRJ5KWDIU' } },
    "--dispatch takes the id of a new run of FAKE-1, FAKE-1-<26 Crockford characters>: 'FAKE-1-01M3BWNZM08Q4T6V2XRJ5KWDIU' is not one",
  ],
])('a dispatched start with %s is refused, with no run directory, lease or claim', async (_, run, refused) => {
  await withTempRepo(async (repo) => {
    writeStub(repo.dir);
    expect(await openStub(repo.dir, run)).toEqual({ refused });
    expect(await leftBehind(repo.dir)).toEqual({ runs: [], leases: [], state: 'Todo', comments: 1 });
  });
});

test('a forced dispatched start opens an undesignated ticket under the dispatched id, via watch with designation overridden, and leaves the ticket as it was', async () => {
  await withTempRepo(async (repo) => {
    writeStub(repo.dir);
    const runId = 'FAKE-3-01M3BWNZM08Q4T6V2XRJ5KWD3N';
    const before = await ticketIn(repo.dir, 'FAKE-3');
    const run = await openStub(repo.dir, { ticket: 'FAKE-3', force: true, dispatch: { runId } });
    expect('refused' in run ? run.refused : 'opened').toBe('opened');
    if ('refused' in run) return;
    const header = readRunHeader(run.dir);
    expect({
      runId: run.runId,
      dir: run.dir,
      source: header.source,
      claim: header.claim,
      ticket: await ticketIn(repo.dir, 'FAKE-3'),
    }).toEqual({
      runId,
      dir: join(repo.dir, '.sail-runs', runId),
      source: { kind: 'ticket', ticketKey: 'FAKE-3', via: 'watch', forced: ['designation'] },
      claim: undefined,
      ticket: before,
    });
  });
});

test('a dispatched start whose run directory exists is refused, and the run directory is left as it was', async () => {
  await withTempRepo(async (repo) => {
    writeStub(repo.dir);
    const dir = join(repo.dir, '.sail-runs', DISPATCHED);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'marker'), 'mine\n');
    expect(await openStub(repo.dir, { ticket: 'FAKE-1', dispatch: { runId: DISPATCHED } })).toEqual({
      refused: `--dispatch names run ${DISPATCHED}, which already exists in .sail-runs: a dispatch starts a new run`,
    });
    expect(await leftBehind(repo.dir)).toEqual({ runs: [DISPATCHED], leases: [], state: 'Todo', comments: 1 });
    expect(readdirSync(dir)).toEqual(['marker']);
  });
});

/** The stub, watched on `sail-review`, with FAKE-6 carrying that label alone. */
function watchedOnReview(repoDir: string): void {
  const sail = writeStub(repoDir);
  edit(
    sail,
    WORKFLOW,
    "workflow('ticket-to-pr', { intake: ticket, version: 1 }",
    "workflow('ticket-to-pr', { intake: ticket, version: 1, watch: { every: '30s', label: 'sail-review' }, maxConcurrentRuns: 1 }",
  );
  const seed = join(sail, 'fake', 'tickets.json');
  const world = JSON.parse(readFileSync(seed, 'utf8'));
  world.tickets.push({ ...world.tickets[0], ticketKey: 'FAKE-6', labels: ['sail-review'] });
  writeFileSync(seed, JSON.stringify(world));
}

test("a workflow's own watch.label is the label a start checks: only the repository's label is not designated, and the workflow's is", async () => {
  const start = (ticket: string) =>
    withTempRepo(async (repo) => {
      watchedOnReview(repo.dir);
      const run = await openStub(repo.dir, { ticket });
      return 'refused' in run
        ? run
        : {
            runId: run.runId.slice(0, 7),
            label: run.header.source.kind === 'ticket' ? run.header.source.ticketKey : '',
          };
    });
  expect([await start('FAKE-1'), await start('FAKE-6')]).toEqual([
    { refused: "the ticket is not designated: it carries no 'sail-review' label. --force runs it anyway" },
    { runId: 'FAKE-6-', label: 'FAKE-6' },
  ]);
});

test('a start from a ticket with --head-sha is refused, with no run directory, lease or claim', async () => {
  await withTempRepo(async (repo) => {
    writeStub(repo.dir);
    expect(await openStub(repo.dir, { ticket: 'FAKE-1', headSha: 'abc1234' })).toEqual({
      refused: '--head-sha pins a pull request to its head, and FAKE-1 is a ticket',
    });
    expect(await leftBehind(repo.dir)).toEqual({ runs: [], leases: [], state: 'Todo', comments: 1 });
  });
});

test("a start whose lease throws is refused, naming the branch and the port's error, with no run directory, workspace, lease or claim", async () => {
  await withTempRepo(async (repo) => {
    writeStub(repo.dir);
    const adapters = await workspaceWith(repo.dir, 'lease', () => async () => {
      throw new PortError('workspace', 'lease', 'unavailable', 'leases are down');
    });
    const run = await openStub(repo.dir, { ticket: 'FAKE-1' }, adapters);
    expect(run).toEqual({
      refused:
        'the branch sail/FAKE-1-add-a-greeting could not be leased: workspace.lease: leases are down (unavailable)',
    });
    expect(await leftBehind(repo.dir)).toEqual({ runs: [], leases: [], state: 'Todo', comments: 1 });
    const worktrees = Bun.spawnSync(['git', 'worktree', 'list', '--porcelain'], { cwd: repo.dir, env: repo.env });
    expect(
      worktrees.stdout
        .toString()
        .split('\n')
        .filter((line) => line.startsWith('worktree ')),
    ).toHaveLength(1);
  });
});

// Named harnesses (ADW-296): resolved on reach, frozen in run.json, and kept on resume.

const SECOND =
  '  workspace: { use: fake }\n  harnesses: { second: { use: fake }, echo: { use: ./adapters/echo-harness.ts } }\n';

/** Makes `deep` name the harness `harness`, which the copy's config defines beside `second` and the credentialed `echo`. */
function nameHarness(sail: string, harness: string, model = 'claude-opus-5-5'): void {
  edit(sail, 'project.yaml', '  workspace: { use: fake }\n', SECOND);
  edit(sail, 'project.yaml', 'deep: claude-opus-5-5', `deep: { harness: ${harness}, model: ${model} }`);
}

test('openRun reaching a named harness records it in run.json with the roster entries that name it, and creates it alone: echo, which needs a credential, is never asked for', async () => {
  await withTempRepo(async (repo) => {
    nameHarness(copyFixture(repo.dir), 'second');
    const run = await openStub(repo.dir, { ticket: 'FAKE-1' });
    if ('refused' in run) throw new Error(run.refused);
    expect(readRunHeader(run.dir).adapters.harnesses).toEqual({ second: { use: 'fake', origin: 'builtin' } });
    expect(Object.keys(run.harnesses)).toEqual(['second']);
    expect(run.header.stages.spec).toMatchObject({ model: 'claude-opus-5-5', harness: 'second' });
    expect(run.header.stages['self-review']).toMatchObject({ harness: 'second' });
    expect(run.header.stages.implement).not.toHaveProperty('harness');
    expect(validateRunDir(run.dir).issues).toEqual([]);
  });
});

test('openRun on a config with no named harness leaves adapters.harnesses and every roster harness out of run.json', async () => {
  await withTempRepo(async (repo) => {
    copyFixture(repo.dir);
    const run = await openStub(repo.dir, { ticket: 'FAKE-1' });
    if ('refused' in run) throw new Error(run.refused);
    expect(run.header.adapters).not.toHaveProperty('harnesses');
    expect(run.harnesses).toEqual({});
    expect(JSON.stringify(run.header.stages)).not.toContain('"harness"');
  });
});

test('openRun reaching a named harness whose adapter needs a variable that is not set is refused naming /adapters/harnesses/<name> and the variable, with no run directory', async () => {
  await withTempRepo(async (repo) => {
    nameHarness(copyFixture(repo.dir), 'echo', 'echo-1');
    const run = await openStub(repo.dir, { ticket: 'FAKE-1' });
    expect(run).toEqual({
      refused: '.sail/project.yaml  /adapters/harnesses/echo needs ECHO_HARNESS_TOKEN, which is not set',
    });
    expect(existsSync(join(repo.dir, '.sail-runs'))).toBe(false);
  });
});

test('openRun reaching a named harness whose variable is set records its origin and versions', async () => {
  await withTempRepo(async (repo) => {
    nameHarness(copyFixture(repo.dir), 'echo', 'echo-1');
    const adapters = await fakeAdapters(repo.dir, { ECHO_HARNESS_TOKEN: 'x' });
    const run = await openStub(repo.dir, { ticket: 'FAKE-1' }, adapters);
    if ('refused' in run) throw new Error(run.refused);
    expect(run.header.adapters.harnesses).toEqual({ echo: ECHO });
  });
});

/** A suspended run that reached `second`, copied into `to` with its `.sail/`. */
async function suspendedOnSecond(to: string): Promise<OpenedRun> {
  return withTempRepo(async (from) => {
    nameHarness(copyFixture(from.dir), 'second');
    const run = await openStub(from.dir, { ticket: 'FAKE-1' });
    if ('refused' in run) throw new Error(run.refused);
    writeStatus(run.dir, 'suspended', 'budget_exceeded');
    copyRun(from.dir, to);
    return run;
  });
}

test('reopenRun resolves the named harnesses the run reached, from its header, and hands them on', async () => {
  await withTempRepo(async (repo) => {
    const run = await suspendedOnSecond(repo.dir);
    const reopened = await reopenRun({ cwd: repo.dir, runId: run.runId, adapters: await fakeAdapters(repo.dir) });
    if ('refused' in reopened) throw new Error(reopened.refused);
    expect(Object.keys(reopened.harnesses)).toEqual(['second']);
  });
});

test('reopenRun refuses a run whose named harness now names another adapter, naming the harness and both', async () => {
  await withTempRepo(async (repo) => {
    const run = await suspendedOnSecond(repo.dir);
    edit(
      join(repo.dir, '.sail'),
      'project.yaml',
      'second: { use: fake }',
      'second: { use: ./adapters/echo-harness.ts }',
    );
    const adapters = await fakeAdapters(repo.dir, { ECHO_HARNESS_TOKEN: 'x' });
    const refused = await reopenRun({ cwd: repo.dir, runId: run.runId, adapters });
    expect(refused).toEqual({
      refused: `run ${run.runId} can't resume on different adapters:\nharnesses.second: the run started with fake (builtin), and .sail/project.yaml now names ./adapters/echo-harness.ts (repo:.sail/adapters/echo-harness.ts)`,
    });
  });
});

test('reopenRun refuses a run whose named harness the config no longer defines', async () => {
  await withTempRepo(async (repo) => {
    const run = await suspendedOnSecond(repo.dir);
    const sail = join(repo.dir, '.sail');
    edit(sail, 'project.yaml', 'deep: { harness: second, model: claude-opus-5-5 }', 'deep: claude-opus-5-5');
    edit(sail, 'project.yaml', 'second: { use: fake }, ', '');
    const refused = await reopenRun({ cwd: repo.dir, runId: run.runId, adapters: await fakeAdapters(repo.dir) });
    expect(refused).toEqual({
      refused: `run ${run.runId} can't resume on different adapters:\nharnesses.second: the run started with fake (builtin), and .sail/project.yaml no longer defines it`,
    });
  });
});

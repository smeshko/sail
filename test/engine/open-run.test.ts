import { afterEach, expect, test } from 'bun:test';
import {
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
import { appendJournal, type NewJournalEntry, readJournal } from '../../src/engine/journal';
import { findRun, type OpenedRun, openRun, reopenRun } from '../../src/engine/open-run';
import { readStatus, writeStatus } from '../../src/engine/run-dir';
import { RUN_HEADER_FILE, type RunHeader, readRunHeader } from '../../src/engine/run-header';
import { ulid } from '../../src/engine/run-id';
import { validateRunDir } from '../../src/engine/schemas';
import { copyFixture, edit } from '../helpers/fixture';
import { copyRun } from '../helpers/stub-workflow';
import { withTempRepo } from '../helpers/temp-repo';

const GOLDEN = join(import.meta.dir, '..', 'fixtures', 'runs', 'FAKE-1-01M3BWNZM08Q4T6V2XRJ5KWD3N');
const WORKFLOW = 'workflows/ticket-to-pr/workflow.ts';
const NOW = new Date('2026-09-27T09:00:00.000Z');

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Opens a run of ticket-to-pr from `cwd`, which must not be refused. */
async function opened(cwd: string, now = NOW): Promise<OpenedRun> {
  const run = await openRun({ cwd, workflow: 'ticket-to-pr', now });
  if ('refused' in run) throw new Error(`refused: ${run.refused}`);
  return run;
}

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

test('a run opened from a subdirectory gets .sail-runs/LOCAL-<ulid>/ with its header, an empty journal and STATUS', async () => {
  await withTempRepo(async (repo) => {
    copyFixture(repo.dir);
    const cwd = join(repo.dir, 'src', 'deep');
    mkdirSync(cwd, { recursive: true });
    const run = await opened(cwd);

    expect(run.runId).toMatch(new RegExp(`^LOCAL-${ulid(NOW.getTime()).slice(0, 10)}[0-9A-HJKMNP-TV-Z]{16}$`));
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
    breakIt(copyFixture(repo.dir));
    const run = await openRun({ cwd: repo.dir, workflow: 'ticket-to-pr' });
    expect(run).toEqual({ refused: expect.stringContaining(reason) });
    expect(existsSync(join(repo.dir, '.sail-runs'))).toBe(false);
  });
});

test('a cwd outside any git repository is refused, and nothing is created', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sail-no-repo-'));
  dirs.push(dir);
  const run = await openRun({ cwd: dir, workflow: 'ticket-to-pr' });
  expect(run).toEqual({ refused: `not inside a git repository: ${dir}` });
  expect(readdirSync(dir)).toEqual([]);
});

test('runs opened a millisecond apart sort in the order they started, and a source gives its ticket key', async () => {
  await withTempRepo(async (repo) => {
    // One run per .sail/ in a process, so each run opens from a .sail/ of its own.
    const [first, second, third] = ['first', 'second', 'third'].map((name) => {
      const dir = join(repo.dir, name);
      mkdirSync(dir);
      copyFixture(dir);
      return dir;
    });
    if (first === undefined || second === undefined || third === undefined) throw new Error('three copies');
    const one = await opened(first, NOW);
    const two = await opened(second, new Date(NOW.getTime() + 1));
    expect(one.runId < two.runId).toBe(true);
    expect([one.runId, two.runId].sort()).toEqual([one.runId, two.runId]);

    const source = { kind: 'ticket', ticketKey: 'FAKE-2', via: 'watch', forced: true } as const;
    const three = await openRun({ cwd: third, workflow: 'ticket-to-pr', source });
    if ('refused' in three) throw new Error(three.refused);
    expect(three.runId).toStartWith('FAKE-2-');
    expect(three.header.source).toEqual(source);
  });
});

test('a second run from one .sail/ in a process throws before it writes anything', async () => {
  await withTempRepo(async (repo) => {
    const sail = copyFixture(repo.dir);
    const first = await opened(repo.dir);
    mkdirSync(join(repo.dir, 'src'));
    const second = openRun({ cwd: join(repo.dir, 'src'), workflow: 'ticket-to-pr' });
    await expect(second).rejects.toThrow(
      `a run from ${sail} already started in this process: Bun can't reload its modules, so each run needs a process of its own`,
    );
    expect(readdirSync(join(repo.dir, '.sail-runs'))).toEqual([first.runId]);
  });
});

test('a .sail/ refused by its project.yaml is not claimed, so a run from it can open once it is fixed', async () => {
  await withTempRepo(async (repo) => {
    const sail = copyFixture(repo.dir);
    edit(sail, 'project.yaml', 'adapters:\n', 'no-adapters:\n');
    expect(await openRun({ cwd: repo.dir, workflow: 'ticket-to-pr' })).toEqual({ refused: expect.any(String) });
    edit(sail, 'project.yaml', 'no-adapters:\n', 'adapters:\n');
    const run = await opened(repo.dir);
    expect(readdirSync(join(repo.dir, '.sail-runs'))).toEqual([run.runId]);
  });
});

test("an input the intake's schema accepts becomes the run's input, parsed", async () => {
  await withTempRepo(async (repo) => {
    const sail = copyFixture(repo.dir);
    const input = {
      ticketKey: 'FAKE-3',
      title: 'Greet loudly',
      url: 'fake://tickets/FAKE-3',
      acceptanceCriteria: ['greet --shout shouts'],
      ignored: true,
    };
    const run = await openRun({ cwd: repo.dir, workflow: 'ticket-to-pr', input });
    if ('refused' in run) throw new Error(run.refused);
    const { ignored: _, ...parsed } = input;
    expect(run.input).toEqual(parsed);
    expect(run.sailDir).toBe(sail);
    expect(run.loaded.workflow.name).toBe('ticket-to-pr');
  });
});

test("an input the intake's schema rejects is refused, and no run directory is created", async () => {
  await withTempRepo(async (repo) => {
    copyFixture(repo.dir);
    const run = await openRun({ cwd: repo.dir, workflow: 'ticket-to-pr', input: { ticketKey: 3 } });
    if (!('refused' in run)) throw new Error('refused');
    expect(run.refused).toStartWith("the input doesn't match intake 'ticket':\n");
    expect(run.refused).toContain('ticketKey');
    expect(existsSync(join(repo.dir, '.sail-runs'))).toBe(false);
  });
});

test('a run opened without an input has none', async () => {
  await withTempRepo(async (repo) => {
    copyFixture(repo.dir);
    const run = await opened(repo.dir);
    expect(run.input).toBeUndefined();
  });
});

const TICKET = { ticketKey: 'FAKE-7', title: 'Greet', url: 'fake://tickets/FAKE-7', acceptanceCriteria: [] };

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
  ['an id that names no run', () => 'LOCAL-NOPE', () => "no run 'LOCAL-NOPE' in .sail-runs"],
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

test('reopenRun reopens a suspended run with the header on disk, its input parsed, and STATUS running again', async () => {
  await withTempRepo(async (repo) => {
    const run = await suspendedCopy(repo.dir);
    const reopened = await reopenRun({ cwd: repo.dir, runId: run.runId, input: { ...TICKET, ignored: true } });
    const dir = join(repo.dir, '.sail-runs', run.runId);
    expect(reopened).toMatchObject({
      runId: run.runId,
      dir,
      header: run.header,
      sailDir: join(repo.dir, '.sail'),
      loaded: { workflow: { name: 'ticket-to-pr' } },
      input: TICKET,
    });
    expect(readStatus(dir)).toEqual({ status: 'running' });
  });
});

test("reopenRun refuses an input the intake's schema rejects, and STATUS is left as it was", async () => {
  await withTempRepo(async (repo) => {
    const run = await suspendedCopy(repo.dir);
    const reopened = await reopenRun({ cwd: repo.dir, runId: run.runId, input: { ticketKey: 3 } });
    expect(reopened).toEqual({ refused: expect.stringMatching(/^the input doesn't match intake 'ticket':\n/) });
    const status = readFileSync(join(repo.dir, '.sail-runs', run.runId, 'STATUS'), 'utf8');
    expect(status).toBe('suspended budget_exceeded\n');
  });
});

// biome-ignore format: TDD-PENDING TASK-006
test
  .skip // TDD-PENDING TASK-006
  ('openRun creates an empty events.ndjson beside the journal, and its events start at seq 1', async () => {
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

// biome-ignore format: TDD-PENDING TASK-006
test
  .skip // TDD-PENDING TASK-006
  .each<[string, (runDir: string) => void, number]>([
    ['continues from the last seq in its events file', (runDir) => writeFileSync(join(runDir, 'events.ndjson'), [1, 2, 3].map(eventLine).join('')), 4],
    ['starts at 1 for a run opened before it had events', (runDir) => rmSync(join(runDir, 'events.ndjson'), { force: true }), 1],
  ])('reopenRun %s', async (_, prepare, firstSeq) => {
    await withTempRepo(async (repo) => {
      const run = await suspendedCopy(repo.dir);
      prepare(join(repo.dir, '.sail-runs', run.runId));
      const reopened = await reopenRun({ cwd: repo.dir, runId: run.runId });
      if ('refused' in reopened) throw new Error(reopened.refused);
      expect(reopened.firstSeq).toBe(firstSeq);
    });
  });

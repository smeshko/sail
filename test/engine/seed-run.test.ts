// openSeededRun(): a new run seeded with a source run's calls before a stage, on the fixture repository's fakes. The
// source is `sail FAKE-1` run to its end once in a repository of its own, and each case seeds from a copy of it: a
// process opens one run per `.sail/`.
import { afterAll, expect, test } from 'bun:test';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { type JournalEntry, readJournal } from '../../src/engine/journal';
import type { OpenedRun } from '../../src/engine/open-run';
import { readStatus } from '../../src/engine/run-dir';
import { type RunHeader, readRunHeader } from '../../src/engine/run-header';
import { openSeededRun, type SeededRunOptions } from '../../src/engine/seed-run';
import { fakeAdapters } from '../helpers/adapters';
import { cutJournal, runIds, SOURCE_BRANCH, sharedSource } from '../helpers/seeded';
import { copyRun } from '../helpers/stub-workflow';
import { type TempRepo, withTempRepo } from '../helpers/temp-repo';

const source = sharedSource();
afterAll(() => source.release());

const STAGES = 'describe, implement, open, self-review, spec, tests';

const sha256 = (path: string) => new Bun.CryptoHasher('sha256').update(readFileSync(path)).digest('hex');

/** Every file under `dir`'s `paths`, each with its sha256, by its path relative to `dir`. */
function filesOf(dir: string, paths: string[]): Record<string, string> {
  const glob = new Bun.Glob('**/*');
  return Object.fromEntries(
    paths.flatMap((path) =>
      [...glob.scanSync({ cwd: join(dir, path), dot: true, onlyFiles: true })]
        .sort()
        .map((file) => [`${path}/${file}`, sha256(join(dir, path, file))]),
    ),
  );
}

/** A seeded run of the copied source in `repo`, with `options` over the defaults. */
async function seed(repo: TempRepo, options: Partial<SeededRunOptions> & { fromRun: string }) {
  return openSeededRun({ cwd: repo.dir, stage: 'spec', adapters: await fakeAdapters(repo.dir), ...options });
}

/** The opened run, once a test has asserted that `result` is no refusal. */
function openedFrom(result: OpenedRun | { refused: string }): OpenedRun {
  expect('refused' in result ? result.refused : 'opened').toBe('opened');
  return result as OpenedRun;
}

test('seeding spec copies the intake call byte for byte, journals intake#1 alone, and records fromRun, no claim, a branch of its own and the base of the source', async () => {
  await withTempRepo(async (repo) => {
    const from = await source.copyInto(repo.dir);
    const sourceHeader = readRunHeader(from.dir);
    const opened = openedFrom(await seed(repo, { fromRun: from.runId }));
    const header: Partial<RunHeader> = readRunHeader(opened.dir);
    const { recordedAt: _, ...intake } = readJournal(from.dir).entries[0] as JournalEntry;
    expect({
      intakeFiles: filesOf(opened.dir, ['00-intake/call-1']),
      spec: existsSync(join(opened.dir, '01-spec')),
      workspace: existsSync(join(opened.dir, 'workspace', '.git')),
      journal: readJournal(opened.dir).entries.map(({ recordedAt: __, ...entry }) => entry),
      fromRun: header.fromRun,
      claim: 'claim' in header,
      branch: header.branch,
      baseSha: header.repository?.baseSha,
      source: header.source,
      status: readStatus(opened.dir),
      until: opened.until,
    }).toEqual({
      intakeFiles: filesOf(from.dir, ['00-intake/call-1']),
      spec: false,
      workspace: true,
      journal: [intake],
      fromRun: from.runId,
      claim: false,
      branch: `${SOURCE_BRANCH}-seeded-${opened.runId.slice(-8).toLowerCase()}`,
      baseSha: sourceHeader.repository?.baseSha,
      source: { kind: 'ticket', ticketKey: 'FAKE-1', via: 'cli', forced: [] },
      status: { status: 'running' },
      until: 'spec',
    });
  });
}, 60_000);

test('seeding self-review journals every call of the source before self-review#1, and copies their call directories with every try', async () => {
  await withTempRepo(async (repo) => {
    const from = await source.copyInto(repo.dir);
    const opened = openedFrom(await seed(repo, { fromRun: from.runId, stage: 'self-review' }));
    const calls = ['00-intake/call-1', '01-spec/call-1', '02-implement/call-1', '02-implement/call-2'];
    const reused = [...calls, '03-tests/call-1', '03-tests/call-2'];
    expect({
      journal: readJournal(opened.dir).entries.map((entry) => `${entry.key} ${entry.outcome}`),
      files: filesOf(opened.dir, reused),
      review: existsSync(join(opened.dir, '04-self-review')),
      seeded: opened.seeded?.entries.map((entry) => entry.key),
    }).toEqual({
      journal: [
        'intake#1 passed',
        'spec#1 done',
        'implement#1 done',
        'tests#1 failed',
        'implement#2 done',
        'tests#2 passed',
      ],
      files: filesOf(from.dir, reused),
      review: false,
      seeded: ['intake#1', 'spec#1', 'implement#1', 'tests#1', 'implement#2', 'tests#2'],
    });
  });
}, 60_000);

/** Rewrites the first journal line of the run in `dir` so its intake failed. */
function failIntake(dir: string): void {
  const path = join(dir, 'journal.ndjson');
  const [first = '', ...rest] = readFileSync(path, 'utf8').split('\n');
  const line = JSON.parse(first);
  writeFileSync(path, [JSON.stringify({ ...line, outcome: 'failed' }), ...rest].join('\n'));
}

/** Rewrites the header of the run in `dir` as a run from before workspaces would have it: no branch, no repository. */
function dropWorkspace(dir: string): void {
  const path = join(dir, 'run.json');
  const { branch: _, repository: __, workspace: ___, ...header } = JSON.parse(readFileSync(path, 'utf8'));
  chmodSync(path, 0o644);
  writeFileSync(path, `${JSON.stringify(header, null, 2)}\n`);
}

const aborted = () => {
  const controller = new AbortController();
  controller.abort();
  return controller.signal;
};

test.each<[string, (dir: string) => void, (runId: string) => Partial<SeededRunOptions>, (runId: string) => string]>([
  ['an id that names no run', () => {}, () => ({ fromRun: 'FAKE-1-NOPE' }), () => "no run 'FAKE-1-NOPE' in .sail-runs"],
  ['an id that is not a plain name', () => {}, () => ({ fromRun: '../x' }), () => "'../x' is not a run id"],
  [
    'a stage the workflow does not have',
    () => {},
    () => ({ stage: 'nope' }),
    () => `--stage names 'nope', which is no stage of workflow 'ticket-to-pr': its stages are ${STAGES}`,
  ],
  [
    'a stage the source never ran',
    (dir) => cutJournal(dir, 2),
    () => ({ stage: 'describe' }),
    (runId) => `run ${runId} never ran 'describe': sail resume ${runId} continues it`,
  ],
  [
    'a source whose intake failed',
    failIntake,
    () => ({}),
    (runId) => `run ${runId}'s intake didn't pass: there is nothing to reuse`,
  ],
  [
    'a source from before workspaces',
    dropWorkspace,
    () => ({}),
    (runId) => `run ${runId} started before runs had workspaces: it can't seed a run`,
  ],
  ['a start that has aborted', () => {}, () => ({ signal: aborted() }), () => 'stopped before the run was opened'],
])(
  'seeding is refused for %s, and leaves only the source run and the fakes',
  async (_, prepare, options, refused) => {
    await withTempRepo(async (repo) => {
      const from = await source.copyInto(repo.dir);
      prepare(from.dir);
      const worktrees = repo.git('worktree', 'list', '--porcelain');
      const result = await seed(repo, { fromRun: from.runId, ...options(from.runId) });
      expect([result, runIds(repo.dir), repo.git('worktree', 'list', '--porcelain')]).toEqual([
        { refused: refused(from.runId) },
        [from.runId],
        worktrees,
      ]);
    });
  },
  60_000,
);

test('a seeded run reads no ticket and claims nothing: the fake ticket state is as it was, and nothing it reports is about the ticket', async () => {
  await withTempRepo(async (repo) => {
    const from = await source.copyInto(repo.dir);
    const tickets = join(repo.dir, '.sail-runs', 'fake', 'tickets.json');
    const before = readFileSync(tickets, 'utf8');
    const opened = openedFrom(await seed(repo, { fromRun: from.runId }));
    expect({
      tickets: readFileSync(tickets, 'utf8'),
      claimed: opened.claimed,
      started: opened.started.map((event) => event.type),
    }).toEqual({ tickets: before, claimed: [], started: ['workspace:leased', 'workspace:created'] });
  });
}, 60_000);

test('two seeded runs from one source both open, each on a branch of its own, and the branch of the source stays free', async () => {
  await withTempRepo(async (first) => {
    const from = await source.copyInto(first.dir);
    const one = openedFrom(await seed(first, { fromRun: from.runId }));
    await withTempRepo(async (second) => {
      copyRun(first.dir, second.dir);
      const two = openedFrom(await seed(second, { fromRun: from.runId }));
      const { workspace } = (await fakeAdapters(second.dir)).ports;
      const holders = await Promise.all(
        [one.workspace.branch, two.workspace.branch, SOURCE_BRANCH].map(
          async (branch) => (await workspace.holder('fake://origin', branch))?.runId,
        ),
      );
      expect([one.workspace.branch === two.workspace.branch, holders]).toEqual([
        false,
        [one.runId, two.runId, undefined],
      ]);
    });
  });
}, 60_000);

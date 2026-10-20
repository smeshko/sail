// dryRun(): a start's preflight and a read of its branch's lease, on the fixture repository's fakes. It answers with
// the header a start would freeze, or with the start's own refusal, and writes nothing either way. A dry run claims the
// `.sail/` for the process as a start does, so a real start to compare with runs in a repository of its own.
import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { dryRun } from '../../src/engine/dry-run';
import { openRun } from '../../src/engine/open-run';
import { PortError } from '../../src/ports/errors';
import { fakeAdapters } from '../helpers/adapters';
import { copyFixture, edit } from '../helpers/fixture';
import { type TempRepo, withTempRepo } from '../helpers/temp-repo';

const BRANCH = 'sail/FAKE-1-add-a-shout-flag-to-the-greet-command';
const HOLDER = 'FAKE-1-01M3BWNZM08Q4T6V2XRJ5KWD3N';
const NO_STAGE =
  "which is no stage of workflow 'ticket-to-pr': its stages are describe, implement, open, self-review, spec, tests";

/** Every file under the repository but its `.git/`, and its worktrees: what a dry run must leave as it was. */
function traces(repo: TempRepo): { files: string[]; worktrees: string; status: string } {
  const glob = new Bun.Glob('**/*');
  const files = [...glob.scanSync({ cwd: repo.dir, dot: true, onlyFiles: true })]
    .filter((file) => !file.startsWith('.git/'))
    .sort();
  return { files, worktrees: repo.git('worktree', 'list', '--porcelain'), status: repo.git('status', '--porcelain') };
}

interface DryOptions {
  ticket?: string;
  force?: boolean;
  until?: string;
}

/** A dry run of ticket-to-pr from the repository, on its fakes. */
async function dry(repo: TempRepo, options: DryOptions = {}) {
  return dryRun({
    cwd: repo.dir,
    workflow: 'ticket-to-pr',
    ticket: 'FAKE-1',
    ...options,
    adapters: await fakeAdapters(repo.dir),
  });
}

/** Leases the fixture's FAKE-1 branch to a run of this process, as a live start would hold it. */
async function leaseBranch(repo: TempRepo): Promise<void> {
  const { workspace } = (await fakeAdapters(repo.dir)).ports;
  const runDir = join(repo.dir, '.sail-runs', HOLDER);
  const taken = await workspace.lease('fake://origin', BRANCH, { runId: HOLDER, runDir, pid: process.pid });
  if (!taken.leased) throw new Error('the branch was already leased');
}

// biome-ignore format: TDD-PENDING TASK-002
test
  .skip // TDD-PENDING TASK-002
  ('dryRun on a designated, unstarted ticket answers with the header a start then freezes, its branch and the ticket as fetched, and writes nothing', async () => {
  const opened = await withTempRepo(async (repo) => {
    copyFixture(repo.dir);
    const run = await openRun({
      cwd: repo.dir,
      workflow: 'ticket-to-pr',
      ticket: 'FAKE-1',
      adapters: await fakeAdapters(repo.dir),
    });
    if ('refused' in run) throw new Error(run.refused);
    return run.header;
  });
  await withTempRepo(async (repo) => {
    copyFixture(repo.dir);
    const before = traces(repo);
    const result = await dry(repo);
    expect('refused' in result ? result.refused : 'answered').toBe('answered');
    if ('refused' in result) return;
    const { header } = result;
    expect([result.branch, result.ticket.title, result.ticket.state]).toEqual([
      BRANCH,
      'Add a --shout flag to the greet command',
      { type: 'unstarted', name: 'Todo' },
    ]);
    expect([header.source, header.claim]).toEqual([
      { kind: 'ticket', ticketKey: 'FAKE-1', via: 'cli', forced: [] },
      { claimed: false, state: { type: 'unstarted', name: 'Todo' } },
    ]);
    const frozen = ({ workflow, adapters, intake, stages, budget }: typeof header) =>
      JSON.stringify({ workflow, adapters, intake, stages, budget });
    expect(frozen(header)).toBe(frozen(opened));
    expect(opened.branch).toBe(BRANCH);
    expect(traces(repo)).toEqual(before);
  });
}, 30_000);

// biome-ignore format: TDD-PENDING TASK-002
test
  .skip // TDD-PENDING TASK-002
  .each<[string, DryOptions, (repo: TempRepo) => Promise<void> | void, string]>([
  [
    'a ticket that is not designated',
    { ticket: 'FAKE-3' },
    () => undefined,
    "the ticket is not designated: it carries no 'sail' label. --force runs it anyway",
  ],
  [
    'a ticket that is already started',
    { ticket: 'FAKE-2' },
    () => undefined,
    'the ticket is already claimed: it is In Progress. --force runs it anyway',
  ],
  [
    'an undefined model alias',
    {},
    (repo) => {
      edit(
        join(repo.dir, '.sail'),
        'project.yaml',
        'models: { default: claude-sonnet-5, deep: claude-opus-5-5 }',
        'models: { default: claude-sonnet-5 }',
      );
    },
    [
      "stage 'self-review' names the model alias 'deep', which .sail/project.yaml's models doesn't define",
      "stage 'spec' names the model alias 'deep', which .sail/project.yaml's models doesn't define",
    ].join('\n'),
  ],
  ['--until naming no stage', { until: 'nope' }, () => undefined, `--until names 'nope', ${NO_STAGE}`],
  ['a branch a live run holds', {}, leaseBranch, `the branch ${BRANCH} is leased by run ${HOLDER} (starting)`],
])(
  'dryRun refuses %s with the words a start refuses it with, and writes nothing',
  async (_, options, prepare, refused) => {
    await withTempRepo(async (repo) => {
      copyFixture(repo.dir);
      await prepare(repo);
      const before = traces(repo);
      expect(await dry(repo, options)).toEqual({ refused });
      expect(traces(repo)).toEqual(before);
    });
  },
);

// biome-ignore format: TDD-PENDING TASK-002
test
  .skip // TDD-PENDING TASK-002
  ('dryRun refuses a workspace whose lease cannot be read, naming the port failure', async () => {
  await withTempRepo(async (repo) => {
    copyFixture(repo.dir);
    const adapters = await fakeAdapters(repo.dir);
    adapters.ports.workspace.holder = async () => {
      throw new PortError('workspace', 'holder', 'unavailable', 'the leases are locked');
    };
    const result = await dryRun({ cwd: repo.dir, workflow: 'ticket-to-pr', ticket: 'FAKE-1', adapters });
    expect(result).toEqual({
      refused: 'the workspace could not be read: workspace.holder: the leases are locked (unavailable)',
    });
  });
});

// biome-ignore format: TDD-PENDING TASK-002
test
  .skip // TDD-PENDING TASK-002
  ('dryRun with force on a ticket that is not designated answers with designation among the forced checks', async () => {
  await withTempRepo(async (repo) => {
    copyFixture(repo.dir);
    const result = await dry(repo, { ticket: 'FAKE-3', force: true });
    expect('refused' in result ? result.refused : 'answered').toBe('answered');
    if ('refused' in result) return;
    expect(result.header.source).toEqual({ kind: 'ticket', ticketKey: 'FAKE-3', via: 'cli', forced: ['designation'] });
  });
});

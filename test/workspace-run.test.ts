// The fixture's ticket-to-pr on `git-worktree`, end to end from the CLI: the epic's four validation steps, and a resume.
// Each case is a copy of the fixture repository whose `.sail/` is left uncommitted, as in a clone being worked on, with
// a committed `.gitignore` for `.sail-runs/` and a local bare `origin`. The ticket source, the code host and the
// harness are the fakes. Every `sail` is a process of its own, spawned with the repository's env, so the leases land in
// its temp HOME's `~/.sail/leases/`.
import { expect, test } from 'bun:test';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readEvents } from '../src/events/consumers/ndjson';
import type { SailEvent } from '../src/events/types';
import { fakeAdapters } from './helpers/adapters';
import { copyFixture, edit } from './helpers/fixture';
import { withOrigin } from './helpers/origin';
import { type TempRepo, withTempRepo } from './helpers/temp-repo';

const MAIN = join(import.meta.dir, '..', 'src', 'cli', 'main.ts');

/** The clone: the fixture's `.sail/` uncommitted, `.sail-runs/` ignored, an origin, and the workspace on git-worktree. */
function cloneOf(repo: TempRepo): string {
  writeFileSync(join(repo.dir, '.gitignore'), '.sail-runs/\n');
  repo.git('add', '.gitignore');
  repo.git('commit', '-q', '-m', 'ignore the runs');
  withOrigin(repo);
  const sail = copyFixture(repo.dir);
  edit(sail, 'project.yaml', 'workspace: { use: fake }', 'workspace: { use: git-worktree }');
  return sail;
}

/** `sail <argv>` in its own process in `repo`, run to its end. */
async function sail(repo: TempRepo, ...argv: string[]): Promise<{ code: number; stderr: string }> {
  const child = Bun.spawn([process.execPath, MAIN, ...argv], {
    cwd: repo.dir,
    env: repo.env,
    stdin: 'ignore',
    stdout: 'ignore',
    stderr: 'pipe',
  });
  const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  return { code, stderr };
}

/** The runs in the clone's `.sail-runs/`: every entry but `fake/`. */
const runIds = (repo: TempRepo): string[] =>
  existsSync(join(repo.dir, '.sail-runs'))
    ? readdirSync(join(repo.dir, '.sail-runs'))
        .filter((name) => name !== 'fake')
        .sort()
    : [];

/** The clone's checkout as a person would look at it. */
const checkout = (repo: TempRepo) => ({
  head: repo.git('rev-parse', 'HEAD'),
  branch: repo.git('symbolic-ref', '--short', 'HEAD'),
  status: repo.git('status', '--porcelain'),
});

/** The worktrees git lists for the clone, other than the clone itself, each with its HEAD and whether it is detached. */
function worktrees(repo: TempRepo): { path: string; head: string; detached: boolean }[] {
  return repo
    .git('worktree', 'list', '--porcelain')
    .split('\n\n')
    .map((block) => block.split('\n'))
    .map((lines) => ({
      path: lines.find((line) => line.startsWith('worktree '))?.slice('worktree '.length) ?? '',
      head: lines.find((line) => line.startsWith('HEAD '))?.slice('HEAD '.length) ?? '',
      detached: lines.includes('detached'),
    }))
    .filter((tree) => tree.path !== '' && tree.path !== repo.dir);
}

/** The leases in the temp HOME, machine-wide for `git-worktree`. */
const leasesIn = (repo: TempRepo): string[] => {
  const dir = join(repo.home, '.sail', 'leases');
  return existsSync(dir) ? readdirSync(dir).filter((name) => name.endsWith('.json')) : [];
};

const find = <T extends SailEvent['type']>(events: SailEvent[], type: T) =>
  events.filter((event): event is Extract<SailEvent, { type: T }> => event.type === type);

test('validation 1 and 2: a run starts in a detached worktree of origin/main under its run directory, and a second run on its branch is refused with exit code 3', async () => {
  await withTempRepo(async (repo) => {
    cloneOf(repo);
    const before = checkout(repo);
    const first = await sail(repo, 'FAKE-1', '--until', 'tests');
    const [runId = ''] = runIds(repo);
    const dir = join(repo.dir, '.sail-runs', runId);
    const created = find(readEvents(dir), 'workspace:created')[0];
    const originMain = repo.git('rev-parse', 'origin/main');
    const comments = async () =>
      (await (await fakeAdapters(repo.dir)).ports.ticketSource.get('FAKE-1')).comments.map((comment) => comment.body);
    const commented = await comments();
    const second = await sail(repo, 'FAKE-1', '--force');
    expect({
      first: first.code,
      worktrees: worktrees(repo),
      baseSha: created?.baseSha,
      checkout: checkout(repo),
      second: { code: second.code, names: second.stderr.includes(`is leased by run ${runId} (suspended)`) },
      runs: runIds(repo),
      comments: await comments(),
    }).toEqual({
      first: 2,
      worktrees: [{ path: join(dir, 'workspace'), head: originMain, detached: true }],
      baseSha: originMain,
      checkout: before,
      second: { code: 3, names: true },
      runs: [runId],
      comments: commented,
    });
  });
}, 60_000);

test("validation 3: with an uncommitted edit in the clone and the run's branch checked out there, sail FAKE-2 --force still starts, and leaves the clone exactly as it was", async () => {
  await withTempRepo(async (repo) => {
    cloneOf(repo);
    repo.git('checkout', '-q', '-b', 'sail/FAKE-2-print-the-version-with-version');
    writeFileSync(join(repo.dir, 'README.md'), 'an edit the run must not see or touch\n', { flag: 'a' });
    const bytes = readFileSync(join(repo.dir, 'README.md'));
    const before = checkout(repo);
    const run = await sail(repo, 'FAKE-2', '--force', '--until', 'spec');
    const [runId = ''] = runIds(repo);
    const branch = find(readEvents(join(repo.dir, '.sail-runs', runId)), 'workspace:leased')[0]?.branch;
    expect({
      code: run.code,
      branch,
      checkout: checkout(repo),
      bytes: readFileSync(join(repo.dir, 'README.md')).equals(bytes),
    }).toEqual({
      code: 2,
      branch: 'sail/FAKE-2-print-the-version-with-version',
      checkout: before,
      bytes: true,
    });
  });
}, 60_000);

test("validation 4: a stage consuming gitDiff('origin/main...HEAD') finds the run's diff in $STAGE_IN, with the file an earlier step wrote", async () => {
  await withTempRepo(async (repo) => {
    const sailDir = cloneOf(repo);
    edit(
      sailDir,
      'stages/tests/stage.ts',
      "import { script, z } from 'sail';",
      "import { gitDiff, script, z } from 'sail';",
    );
    edit(
      sailDir,
      'stages/tests/stage.ts',
      "  run: './run.sh',",
      "  run: './run.sh',\n  consumes: { diff: gitDiff('origin/main...HEAD') },",
    );
    edit(
      sailDir,
      'stages/tests/run.sh',
      'if [ "$CALL" = 1 ]; then',
      'cp "$INPUT_DIFF" "$STAGE_OUT/diff.patch"\nif [ "$CALL" = 1 ]; then echo "made by tests#1" >"$WORKSPACE/made.txt"; fi\nif [ "$CALL" = 1 ]; then',
    );
    const run = await sail(repo, 'FAKE-1');
    const [runId = ''] = runIds(repo);
    const patch = (call: number) => {
      const file = join(repo.dir, '.sail-runs', runId, '03-tests', `call-${call}`, 'diff.patch');
      return existsSync(file) ? readFileSync(file, 'utf8') : null;
    };
    expect({ code: run.code, first: patch(1), second: patch(2)?.includes('+++ b/made.txt') }).toEqual({
      code: 0,
      first: '',
      second: true,
    });
  });
}, 60_000);

test('sail resume continues a suspended run in its own worktree, then releases the worktree and the lease', async () => {
  await withTempRepo(async (repo) => {
    cloneOf(repo);
    const first = await sail(repo, 'FAKE-1', '--until', 'tests');
    const [runId = ''] = runIds(repo);
    const dir = join(repo.dir, '.sail-runs', runId);
    const held = leasesIn(repo);
    const resumed = await sail(repo, 'resume', runId);
    const cwds = [...new Set(find(readEvents(dir), 'script:exec').map((event) => event.cwd))];
    expect({
      codes: [first.code, resumed.code],
      held: held.length,
      cwds,
      after: { worktrees: worktrees(repo), leases: leasesIn(repo) },
    }).toEqual({
      codes: [2, 0],
      held: 1,
      cwds: [`.sail-runs/${runId}/workspace`],
      after: { worktrees: [], leases: [] },
    });
  });
}, 60_000);

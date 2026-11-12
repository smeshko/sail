// A run on the fake workspace with `standing: true` (ADW-554): a start takes a standing workspace of its workflow, the
// run header records where it is, a resume finds it there, an end keeps it and frees it, and a start that finds none
// free gets a workspace of its own. A process opens one run per `.sail/`, so each run is a `sail` process of its own,
// as the CLI's callers start them. The stub's `ticket-to-pr` declares no `maxConcurrentRuns`: one standing workspace.
import { expect, test } from 'bun:test';
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readStanding, standingDir, standingPath } from '../../src/adapters/workspace/standing';
import { EXIT_SUSPENDED } from '../../src/cli/exit-codes';
import { openRun } from '../../src/engine/open-run';
import { RUN_HEADER_FILE, readRunHeader } from '../../src/engine/run-header';
import { listRuns } from '../../src/engine/runs';
import { formatIssue, validateRunDir } from '../../src/engine/schemas';
import { readEvents } from '../../src/events/consumers/ndjson';
import { fakeAdapters } from '../helpers/adapters';
import { edit } from '../helpers/fixture';
import { writeStub } from '../helpers/stub-workflow';
import { type TempRepo, withTempRepo } from '../helpers/temp-repo';

const WORKFLOW = 'ticket-to-pr';
const HEADER_PATH = `../standing/${WORKFLOW}-0/workspace`;
const MAIN = join(import.meta.dir, '..', '..', 'src', 'cli', 'main.ts');

/** `sail <args>` as a process in `repo`: its exit code and what it printed. */
function sail(repo: TempRepo, ...args: string[]) {
  const child = Bun.spawnSync([process.execPath, MAIN, ...args], {
    cwd: repo.dir,
    env: repo.env,
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  return { code: child.exitCode, stdout: child.stdout.toString(), stderr: child.stderr.toString() };
}

/** The directory of the run of `ticket` `n` (the first by name) in `repo`. */
function runDirOf(repo: TempRepo, ticket: string): string {
  const runs = join(repo.dir, '.sail-runs');
  const name = readdirSync(runs).find((entry) => entry.startsWith(`${ticket}-`));
  if (name === undefined) throw new Error(`no run of ${ticket} in ${runs}`);
  return join(runs, name);
}

/** A temp repository with the stub, its fake workspace standing, and `cache/` ignored. */
async function standingRepo<T>(
  fn: (repo: TempRepo, path: string, lease: () => string | undefined) => Promise<T>,
): Promise<T> {
  return withTempRepo(async (repo) => {
    writeStub(repo.dir, { testsPassAt: 1 });
    edit(
      join(repo.dir, '.sail'),
      'project.yaml',
      'workspace: { use: fake }',
      'workspace: { use: fake, standing: true }',
    );
    mkdirSync(join(repo.dir, '.git', 'info'), { recursive: true });
    appendFileSync(join(repo.dir, '.git', 'info', 'exclude'), 'cache/\n');
    const runs = join(repo.dir, '.sail-runs');
    return fn(repo, standingPath(runs, WORKFLOW, 0), () => readStanding(standingDir(runs, WORKFLOW, 0))?.runId);
  });
}

const created = (dir: string) => readEvents(dir).filter((event) => event.type === 'workspace:created');
const workspaceOf = (dir: string): string => readRunHeader(dir).workspace ?? '';

test('a ticket start records the standing workspace in run.json, runs there, keeps it when it ends and frees it; the next start takes the same path and finds the ignored file', async () => {
  await standingRepo(async (repo, path, lease) => {
    expect(sail(repo, 'FAKE-1', '--workflow', WORKFLOW).code).toBe(0);
    const first = runDirOf(repo, 'FAKE-1');
    expect(workspaceOf(first)).toBe(HEADER_PATH);
    expect(validateRunDir(first).issues.map(formatIssue)).toEqual([]);
    expect(created(first)).toMatchObject([{ path: `.sail-runs/standing/${WORKFLOW}-0/workspace`, standing: 'leased' }]);
    expect(readEvents(first).filter((event) => event.type === 'workspace:released')).toMatchObject([
      { path: `.sail-runs/standing/${WORKFLOW}-0/workspace`, kept: true },
    ]);
    expect(existsSync(join(path, '.git'))).toBe(true);
    expect(lease()).toBeUndefined();
    expect(existsSync(join(first, 'workspace'))).toBe(false);

    mkdirSync(join(path, 'cache'));
    writeFileSync(join(path, 'cache', 'warm'), 'warm');
    writeFileSync(join(path, 'left.txt'), 'left');
    expect(sail(repo, 'FAKE-2', '--workflow', WORKFLOW).code).toBe(0);
    const second = runDirOf(repo, 'FAKE-2');
    expect(created(second)).toMatchObject([
      { path: `.sail-runs/standing/${WORKFLOW}-0/workspace`, standing: 'leased' },
    ]);
    expect(readFileSync(join(path, 'cache', 'warm'), 'utf8')).toBe('warm');
    expect(existsSync(join(path, 'left.txt'))).toBe(false);
  });
}, 120_000);

test('a run suspended with --until resumes in the same standing workspace, with its uncommitted file, and makes no new workspace', async () => {
  await standingRepo(async (repo, path, lease) => {
    expect(sail(repo, 'FAKE-1', '--workflow', WORKFLOW, '--until', 'spec').code).toBe(EXIT_SUSPENDED);
    const dir = runDirOf(repo, 'FAKE-1');
    const runId = dir.split('/').at(-1) ?? '';
    expect(lease()).toBe(runId);
    writeFileSync(join(path, 'wip.txt'), 'wip');

    expect(sail(repo, 'resume', runId).code).toBe(0);
    expect(created(dir)).toHaveLength(1);
    expect(workspaceOf(dir)).toBe(HEADER_PATH);
    expect(readEvents(dir).filter((event) => event.type === 'workspace:released')).toMatchObject([{ kept: true }]);
    expect(existsSync(join(path, 'wip.txt'))).toBe(true);
    expect(lease()).toBeUndefined();
  });
}, 120_000);

test('a second start while the first is suspended, for a workflow with one standing workspace, runs in its own workspace saying none_free, and records workspace', async () => {
  await standingRepo(async (repo, path, lease) => {
    expect(sail(repo, 'FAKE-1', '--workflow', WORKFLOW, '--until', 'spec').code).toBe(EXIT_SUSPENDED);
    const held = runDirOf(repo, 'FAKE-1').split('/').at(-1);
    expect(sail(repo, 'FAKE-2', '--workflow', WORKFLOW).code).toBe(0);
    const other = runDirOf(repo, 'FAKE-2');
    const otherId = other.split('/').at(-1);
    expect(workspaceOf(other)).toBe('workspace');
    expect(created(other)).toMatchObject([{ path: `.sail-runs/${otherId}/workspace`, standing: 'none_free' }]);
    expect(existsSync(join(other, 'workspace'))).toBe(false);
    expect(lease()).toBe(held);
    expect(existsSync(path)).toBe(true);
  });
}, 120_000);

test('a run.json that cannot be written once the standing workspace is made throws, and leaves the standing workspace free and no run directory', async () => {
  await standingRepo(async (repo, path, lease) => {
    const adapters = await fakeAdapters(repo.dir);
    const { workspace } = adapters.ports;
    const create = workspace.create.bind(workspace);
    workspace.create = async (run, options) => {
      const made = await create(run, options);
      mkdirSync(join(run.runDir, RUN_HEADER_FILE), { recursive: true });
      return made;
    };
    await expect(openRun({ cwd: repo.dir, adapters, workflow: WORKFLOW, ticket: 'FAKE-1' })).rejects.toThrow(
      'directory was not written',
    );
    expect(lease()).toBeUndefined();
    expect(existsSync(join(path, '.git'))).toBe(true);
    expect(readdirSync(join(repo.dir, '.sail-runs')).filter((name) => name !== 'fake' && name !== 'standing')).toEqual(
      [],
    );
  });
});

test('a runs listing has no entry for .sail-runs/standing/', async () => {
  await standingRepo(async (repo) => {
    expect(sail(repo, 'FAKE-1', '--workflow', WORKFLOW).code).toBe(0);
    const runId = runDirOf(repo, 'FAKE-1').split('/').at(-1) ?? '';
    expect(listRuns(join(repo.dir, '.sail')).map((run) => run.runId)).toEqual([runId]);
  });
}, 120_000);

test('with the option off, run.json records workspace as before and no standing directory exists', async () => {
  await withTempRepo(async (repo) => {
    writeStub(repo.dir, { testsPassAt: 1 });
    expect(sail(repo, 'FAKE-1', '--workflow', WORKFLOW).code).toBe(0);
    const dir = runDirOf(repo, 'FAKE-1');
    expect(workspaceOf(dir)).toBe('workspace');
    expect(created(dir)[0]).not.toHaveProperty('standing');
    expect(existsSync(join(repo.dir, '.sail-runs', 'standing'))).toBe(false);
  });
}, 120_000);

// sail's own review sync-base stage, run as a script on the fake code host: a base the branch already holds is nothing
// to do, a moved base is merged in with a merge commit, and a conflicting one is left in progress with its paths named.
import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { writeOwnSail } from '../helpers/own-sail';
import { type TempRepo, withTempRepo } from '../helpers/temp-repo';

const ROOT = join(import.meta.dir, '..', '..');

interface Synced {
  moved: boolean;
  baseSha: string;
  conflicts: string[];
}

/** Commits `text` to `file` on the checked-out branch: the new head. */
function commit(repo: TempRepo, file: string, text: string, message: string): string {
  writeFileSync(join(repo.dir, file), text);
  repo.git('add', file);
  repo.git('commit', '-m', message);
  return repo.git('rev-parse', 'HEAD').trim();
}

/**
 * The repository's own `.sail/` with notes.txt, then the pull request's commit to it on the checked-out branch and,
 * when `base` is given, its commit on `staging`, which the seed makes pull request #7's base sha.
 */
function setUp(repo: TempRepo, base?: { file: string; text: string }): { head: string; baseSha: string } {
  writeOwnSail(repo);
  const start = commit(repo, 'notes.txt', 'one\n', 'notes');
  repo.git('branch', 'staging');
  const head = commit(repo, 'notes.txt', 'one\ntwo from the pull request\n', 'the pull request');
  let baseSha = start;
  if (base !== undefined) {
    repo.git('checkout', '-q', 'staging');
    baseSha = commit(repo, base.file, base.text, 'the base moves');
    repo.git('checkout', '-q', '-');
  }
  const prs = join(repo.dir, '.sail', 'fake', 'prs.json');
  const world = JSON.parse(readFileSync(prs, 'utf8'));
  Object.assign(world.pullRequests[0], { headSha: head, baseSha });
  writeFileSync(prs, JSON.stringify(world));
  return { head, baseSha };
}

/** Runs the sync-base stage's run.sh in `repo`: its exit code, stderr, and its last stdout line parsed. */
function runSync(repo: TempRepo): { code: number; stderr: string; output: Synced } {
  const stageDir = join(repo.dir, '.sail', 'workflows', 'review', 'stages', '19-sync-base');
  const out = join(repo.home, 'stage-out');
  mkdirSync(out);
  const files = { INPUT_PR: join(out, 'pr.json'), INPUT_TICKETKEY: join(out, 'ticketKey.txt') };
  writeFileSync(files.INPUT_PR, JSON.stringify({ number: 7, url: 'fake://codehost/sail/pull/7' }));
  writeFileSync(files.INPUT_TICKETKEY, 'FAKE-1');
  const child = Bun.spawnSync([join(stageDir, 'run.sh')], {
    cwd: repo.dir,
    env: {
      ...repo.env,
      ...files,
      PATH: `${join(ROOT, 'bin')}:${repo.env.PATH ?? ''}`,
      SAIL_BUN: process.execPath,
      SAIL_CONFIG: join(repo.dir, '.sail', 'project.yaml'),
      STAGE_OUT: out,
    },
  });
  const lines = child.stdout.toString().trim().split('\n');
  return { code: child.exitCode ?? -1, stderr: child.stderr.toString(), output: JSON.parse(lines.at(-1) ?? 'null') };
}

test('a base the branch already holds is nothing to do: no merge, the head unchanged', async () => {
  await withTempRepo(async (repo) => {
    const { head, baseSha } = setUp(repo);
    const { code, output } = runSync(repo);
    expect(code).toBe(0);
    expect(output).toEqual({ moved: false, baseSha, conflicts: [] });
    expect(repo.git('rev-parse', 'HEAD').trim()).toBe(head);
  });
}, 60_000);

test('a moved base that merges cleanly is committed as a merge naming the base and the ticket', async () => {
  await withTempRepo(async (repo) => {
    const { head, baseSha } = setUp(repo, { file: 'other.txt', text: 'a new file\n' });
    const { code, output } = runSync(repo);
    expect(code).toBe(0);
    expect(output).toEqual({ moved: true, baseSha, conflicts: [] });
    expect(repo.git('log', '-1', '--format=%P%n%s').trim()).toBe(
      `${head} ${baseSha}\nMerge staging into the pull request (FAKE-1)`,
    );
    expect(existsSync(join(repo.dir, '.git', 'MERGE_HEAD'))).toBe(false);
    expect(readFileSync(join(repo.dir, 'other.txt'), 'utf8')).toBe('a new file\n');
  });
}, 60_000);

test('a moved base that conflicts leaves the merge in progress and names the conflicted paths', async () => {
  await withTempRepo(async (repo) => {
    const { head, baseSha } = setUp(repo, { file: 'notes.txt', text: 'one\ntwo from the base\n' });
    const { code, output } = runSync(repo);
    expect(code).toBe(0);
    expect(output).toEqual({ moved: true, baseSha, conflicts: ['notes.txt'] });
    expect(repo.git('rev-parse', 'HEAD').trim()).toBe(head);
    expect(existsSync(join(repo.dir, '.git', 'MERGE_HEAD'))).toBe(true);
  });
}, 60_000);

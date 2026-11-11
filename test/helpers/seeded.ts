// A source run for seeded runs to reuse: `sail FAKE-1` on a copy of the fixture repository, run to its end once per test
// file in a repository kept until the file's last case. A process opens one run per `.sail/`, so a case never seeds
// from that repository: it copies the repository's `.sail/`, `.sail-runs/` and `.git/` into its own, and seeds there.
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { EXIT_FAILED, EXIT_OK } from '../../src/cli/exit-codes';
import { copyFixture, edit } from './fixture';
import { runCaptured } from './run-captured';
import { copyRun } from './stub-workflow';
import { type TempRepo, withTempRepo } from './temp-repo';

/** The branch a run of the fixture's FAKE-1 works on. */
export const SOURCE_BRANCH = 'sail/FAKE-1-add-a-shout-flag-to-the-greet-command';

/** The journal a run of the fixture's FAKE-1 to its end holds, as `<key> <outcome>`. */
export const SOURCE_JOURNAL = [
  'intake#1 passed',
  'spec#1 done',
  'implement#1 done',
  'tests#1 failed',
  'implement#2 done',
  'tests#2 passed',
  'self-review#1 done',
  'publish#1/describe done',
  'publish#1/open passed',
  'publish#1 passed',
];

/** The runs in a repository's `.sail-runs/`, sorted: every entry but `fake/`, where the fakes keep their state. */
export const runIds = (repoDir: string): string[] =>
  existsSync(join(repoDir, '.sail-runs'))
    ? readdirSync(join(repoDir, '.sail-runs'))
        .filter((name) => name !== 'fake')
        .sort()
    : [];

export interface SharedSource {
  /** The repository holding the completed source run, and the run's id. Made on the first call. */
  get(): Promise<{ repo: TempRepo; runId: string }>;
  /** Copies the source repository into `to`, its worktrees repaired, and answers with the source run there. */
  copyInto(to: string): Promise<{ runId: string; dir: string }>;
  /** Lets the source repository go: call it from the file's `afterAll`. */
  release(): void;
}

/** A source run for one test file. */
export function sharedSource(): SharedSource {
  let made: Promise<{ repo: TempRepo; runId: string }> | undefined;
  let release = (): void => {};
  const get = () => {
    made ??= new Promise((resolve, reject) => {
      withTempRepo(async (repo) => {
        copyFixture(repo.dir);
        const ran = await runCaptured(['FAKE-1'], repo.dir, { env: repo.env });
        if (ran.code !== EXIT_OK) throw new Error(`the source run exited ${ran.code}: ${ran.stderr}`);
        const [runId = ''] = runIds(repo.dir);
        resolve({ repo, runId });
        await new Promise<void>((done) => {
          release = done;
        });
      }).catch(reject);
    });
    return made;
  };
  return {
    get,
    async copyInto(to) {
      const { repo, runId } = await get();
      copyRun(repo.dir, to);
      return { runId, dir: join(to, '.sail-runs', runId) };
    },
    release: () => release(),
  };
}

/** Reorders every journal line exactly once and renumbers seq in completion order. */
export function reorderJournal(runDir: string, keys: string[]): void {
  const path = join(runDir, 'journal.ndjson');
  const lines = readFileSync(path, 'utf8')
    .trimEnd()
    .split('\n')
    .map((line) => JSON.parse(line));
  const byKey = new Map(lines.map((line) => [line.key, line]));
  if (keys.length !== lines.length || new Set(keys).size !== keys.length || keys.some((key) => !byKey.has(key))) {
    throw new Error('keys must name every journal line exactly once');
  }
  writeFileSync(
    path,
    `${keys.map((key, index) => JSON.stringify({ ...byKey.get(key), seq: index + 1 })).join('\n')}\n`,
  );
}

/** Keeps the first `count` lines of a run's journal: a source that stopped there. */
export function cutJournal(runDir: string, count: number): void {
  const path = join(runDir, 'journal.ndjson');
  const lines = readFileSync(path, 'utf8').split('\n').slice(0, count);
  writeFileSync(path, `${lines.join('\n')}\n`);
}

const OPEN_SCRIPT = 'workflows/ticket-to-pr/stages/publish/open.sh';
const PUSH = 'sail port codehost push "$branch" >/dev/null\n';

/**
 * Makes a copy's `open` step leave what a push leaves in the repository, a remote-tracking ref reaching the head, since
 * the fake code host's push writes no git ref; with `fail`, it then exits 1, so the run fails after its push.
 */
export function markPushed(sailDir: string, options: { fail: boolean }): void {
  edit(
    sailDir,
    OPEN_SCRIPT,
    PUSH,
    `${PUSH}git update-ref "refs/remotes/origin/$branch" HEAD\n${options.fail ? 'exit 1\n' : ''}`,
  );
}

/**
 * A source that pushed its branch and then failed: `sail FAKE-1` on a copy of the fixture whose `open` step fails after
 * its push. It answers with the run's id and directory, its base, and the commit it pushed.
 */
export async function pushedSource(
  repo: TempRepo,
): Promise<{ runId: string; dir: string; base: string; head: string }> {
  copyFixture(repo.dir);
  markPushed(join(repo.dir, '.sail'), { fail: true });
  const ran = await runCaptured(['FAKE-1'], repo.dir, { env: repo.env });
  if (ran.code !== EXIT_FAILED) throw new Error(`the pushed source run exited ${ran.code}: ${ran.stderr}`);
  const [runId = ''] = runIds(repo.dir);
  const dir = join(repo.dir, '.sail-runs', runId);
  const base: string = JSON.parse(readFileSync(join(dir, 'run.json'), 'utf8')).repository.baseSha;
  return { runId, dir, base, head: repo.git('rev-parse', `refs/remotes/origin/${SOURCE_BRANCH}`) };
}

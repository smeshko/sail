// A source run for seeded runs to reuse: `sail FAKE-1` on a copy of the fixture repository, run to its end once per test
// file in a repository kept until the file's last case. A process opens one run per `.sail/`, so a case never seeds
// from that repository: it copies the repository's `.sail/`, `.sail-runs/` and `.git/` into its own, and seeds there.
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { EXIT_OK } from '../../src/cli/exit-codes';
import { copyFixture } from './fixture';
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

/** Keeps the first `count` lines of a run's journal: a source that stopped there. */
export function cutJournal(runDir: string, count: number): void {
  const path = join(runDir, 'journal.ndjson');
  const lines = readFileSync(path, 'utf8').split('\n').slice(0, count);
  writeFileSync(path, `${lines.join('\n')}\n`);
}

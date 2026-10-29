// sail's own review merge stage, run as a script on the fake code host: a failed check rerun once, a red check handed
// back with its log, the last try failing with a comment and the label off, a rejected merge handed back as a base
// retry, and a merge that lands after a retry saying what it took.
import { expect, test } from 'bun:test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { writeOwnSail } from '../helpers/own-sail';
import { type TempRepo, withTempRepo } from '../helpers/temp-repo';

const ROOT = join(import.meta.dir, '..', '..');
const HEAD = 'c'.repeat(40);

interface Merged {
  merged: boolean;
  sha: string | null;
  reason: string;
  retry: 'checks' | 'base' | null;
  failed: { name: string; url: string | null; log: string }[];
  rerun: string[];
}

/** Seeds pull request #7 at HEAD with `checks` and `merges` scripted, in `repo`'s copy of `.sail/`. */
function seedPullRequest(repo: TempRepo, checks: object[], merges: string[] = ['merged']): void {
  const prs = join(repo.dir, '.sail', 'fake', 'prs.json');
  const world = JSON.parse(readFileSync(prs, 'utf8'));
  Object.assign(world.pullRequests[0], { headSha: HEAD, checks, merges });
  writeFileSync(prs, JSON.stringify(world));
}

/** `sail port codehost …` in `repo`: its last stdout line, parsed. */
function port(repo: TempRepo, ...args: string[]): { labels: string[]; comments: { body: string }[] } {
  const child = Bun.spawnSync([join(ROOT, 'bin', 'sail'), 'port', 'codehost', ...args], {
    cwd: repo.dir,
    env: { ...repo.env, SAIL_BUN: process.execPath },
  });
  return JSON.parse(child.stdout.toString().trim().split('\n').at(-1) ?? 'null');
}

/** Runs the merge stage's run.sh in `repo`: its exit code, stderr, and its last stdout line parsed. */
function runMerge(
  repo: TempRepo,
  options: { lastTry?: boolean; landing?: string[]; blocked?: string } = {},
): { code: number; stderr: string; output: Merged } {
  const stageDir = join(repo.dir, '.sail', 'workflows', 'review', 'stages', '18-merge');
  const out = join(repo.home, `stage-out-${Date.now()}`);
  mkdirSync(out);
  const inputs: Record<string, string> = {
    INPUT_PR: JSON.stringify({ number: 7, url: 'fake://codehost/sail/pull/7' }),
    INPUT_HEADSHA: HEAD,
    INPUT_LABEL: 'factory',
    INPUT_LASTTRY: JSON.stringify(options.lastTry ?? false),
    INPUT_LANDING: JSON.stringify(options.landing ?? []),
    ...(options.blocked === undefined ? {} : { INPUT_BLOCKED: options.blocked }),
  };
  const env: Record<string, string> = {};
  for (const [name, text] of Object.entries(inputs)) {
    env[name] = join(out, `${name}.in`);
    writeFileSync(env[name], text);
  }
  const child = Bun.spawnSync([join(stageDir, 'run.sh')], {
    cwd: repo.dir,
    env: {
      ...repo.env,
      ...env,
      PATH: `${join(ROOT, 'bin')}:${repo.env.PATH ?? ''}`,
      SAIL_BUN: process.execPath,
      SAIL_CONFIG: join(repo.dir, '.sail', 'project.yaml'),
      STAGE_OUT: out,
    },
  });
  const lines = child.stdout.toString().trim().split('\n');
  return { code: child.exitCode ?? -1, stderr: child.stderr.toString(), output: JSON.parse(lines.at(-1) ?? 'null') };
}

test('a check that fails once and passes on its rerun is merged, and the comment says it was rerun', async () => {
  await withTempRepo(async (repo) => {
    writeOwnSail(repo);
    seedPullRequest(repo, [{ name: 'verify', statuses: ['failed', 'passed'] }]);
    const { code, output } = runMerge(repo);
    expect(code).toBe(0);
    expect(output).toMatchObject({ merged: true, retry: null, rerun: ['verify'] });
    const pr = port(repo, 'get-pull-request', '7');
    expect(pr.comments.map((each) => each.body)).toEqual([
      '## sail review\n\nMerged after the review:\n\n- reran verify once\n',
    ]);
    expect(pr.labels).toContain('factory');
  });
}, 60_000);

test('a check still red after its rerun is handed back as a checks retry with its log, the label kept and nothing commented', async () => {
  await withTempRepo(async (repo) => {
    writeOwnSail(repo);
    seedPullRequest(repo, [
      { name: 'verify', statuses: ['failed'], log: '(fail) sail show prints a zero total\n 1 fail' },
      { name: 'lint', statuses: ['passed'] },
    ]);
    const { code, output } = runMerge(repo);
    expect(code).toBe(0);
    expect(output).toMatchObject({ merged: false, retry: 'checks', rerun: ['verify'] });
    expect(output.failed).toEqual([
      { name: 'verify', url: null, log: '(fail) sail show prints a zero total\n 1 fail' },
    ]);
    const pr = port(repo, 'get-pull-request', '7');
    expect([pr.comments, pr.labels.includes('factory')]).toEqual([[], true]);
  });
}, 60_000);

test('a red check with no log to read is handed back saying so', async () => {
  await withTempRepo(async (repo) => {
    writeOwnSail(repo);
    seedPullRequest(repo, [{ name: 'verify', statuses: ['failed'] }]);
    const { output } = runMerge(repo);
    expect(output.retry).toBe('checks');
    expect(output.failed[0]?.log).toStartWith('no log: ');
  });
}, 60_000);

test('on the last try a red check comments what the review took, swaps the label for needs-human and exits 1', async () => {
  await withTempRepo(async (repo) => {
    writeOwnSail(repo);
    seedPullRequest(repo, [{ name: 'verify', statuses: ['failed'], log: 'boom' }]);
    const { code, output } = runMerge(repo, { lastTry: true, landing: ['merged the base in'] });
    expect(code).toBe(1);
    expect(output).toMatchObject({ merged: false, retry: null, reason: 'checks failed: verify' });
    const pr = port(repo, 'get-pull-request', '7');
    expect(pr.labels).not.toContain('factory');
    expect(pr.labels).toContain('needs-human');
    expect(pr.comments.map((each) => each.body)).toEqual([
      '## sail review\n\nNot merged: checks failed: verify\n\nBefore that, the review:\n\n- merged the base in\n- reran verify once\n\nThe `factory` label is off and `needs-human` is on: this pull request needs a human.\n',
    ]);
  });
}, 60_000);

test('a merge the host rejects is handed back as a base retry', async () => {
  await withTempRepo(async (repo) => {
    writeOwnSail(repo);
    seedPullRequest(repo, [{ name: 'verify', statuses: ['passed'] }], ['rejected']);
    const { code, output } = runMerge(repo);
    expect(code).toBe(0);
    expect(output).toMatchObject({ merged: false, retry: 'base', rerun: [] });
    expect(output.reason).toStartWith('the host rejected the merge: ');
  });
}, 60_000);

test('a merge after a landing pass comments what it took', async () => {
  await withTempRepo(async (repo) => {
    writeOwnSail(repo);
    seedPullRequest(repo, [{ name: 'verify', statuses: ['passed'] }]);
    const { code, output } = runMerge(repo, {
      landing: ['fixed the failed checks verify in 1 commit'],
    });
    expect([code, output.merged]).toEqual([0, true]);
    expect(port(repo, 'get-pull-request', '7').comments.map((each) => each.body)).toEqual([
      '## sail review\n\nMerged after the review:\n\n- fixed the failed checks verify in 1 commit\n',
    ]);
  });
}, 60_000);

test('a blocked merge reads no check, comments the reason, takes the label off and exits 1', async () => {
  await withTempRepo(async (repo) => {
    writeOwnSail(repo);
    seedPullRequest(repo, [{ name: 'verify', statuses: ['passed'] }]);
    const { code, output, stderr } = runMerge(repo, { blocked: 'validation failed after the fix' });
    expect(code).toBe(1);
    expect(stderr).not.toContain('checks:');
    expect(output).toMatchObject({ merged: false, reason: 'validation failed after the fix' });
    expect(port(repo, 'get-pull-request', '7').labels).not.toContain('factory');
  });
}, 60_000);

// `sail resume --raise-budget`: the fixture's ticket-to-pr with a run budget of $0.50, through the CLI on the fakes,
// every `sail` a process of its own with the repository's env, so the branch lease lands in its temp HOME. The run is
// suspended over its budget once, and kept until the file's last case: the cases read it, refuse to resume it, then
// resume it with a raise, in order.
import { afterAll, expect, test } from 'bun:test';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readEvents } from '../../src/events/consumers/ndjson';
import { copyFixture, edit } from '../helpers/fixture';
import { sail } from '../helpers/sail-process';
import { type TempRepo, withTempRepo } from '../helpers/temp-repo';

interface Suspended {
  repo: TempRepo;
  runId: string;
  dir: string;
  code: number;
  stdout: string;
}

let release = (): void => {};
let shared: Promise<Suspended> | undefined;

/** `sail FAKE-1` with `maxUsd: 0.5` in a copy of the fixture repository, run once and kept until the last case. */
function suspendedRun(): Promise<Suspended> {
  shared ??= new Promise<Suspended>((resolve, reject) => {
    withTempRepo(async (repo) => {
      const sailDir = copyFixture(repo.dir);
      edit(
        sailDir,
        'project.yaml',
        'budgets: { run: { maxUsd: 25, maxMinutes: 90 } }',
        'budgets: { run: { maxUsd: 0.5 } }',
      );
      const ran = await sail(repo.dir, repo.env, ['FAKE-1']);
      const runs = join(repo.dir, '.sail-runs');
      const [runId = ''] = existsSync(runs) ? readdirSync(runs).filter((name) => name !== 'fake') : [];
      resolve({ repo, runId, dir: join(runs, runId), code: ran.code, stdout: ran.stdout });
      await new Promise<void>((done) => {
        release = done;
      });
    }).catch(reject);
  });
  return shared;
}
afterAll(() => release());

const status = (dir: string) => readFileSync(join(dir, 'STATUS'), 'utf8');

let resumedOnce: Promise<{ code: number; stdout: string; stderr: string }> | undefined;
/** `sail resume <run> --raise-budget 5` on the suspended run, once. */
async function raisedResume(): Promise<{ code: number; stdout: string; stderr: string }> {
  const { repo, runId } = await suspendedRun();
  resumedOnce ??= sail(repo.dir, repo.env, ['resume', runId, '--raise-budget', '5']);
  return resumedOnce;
}

test('sail FAKE-1 over its budget exits 2 and names the flag that raises it, and while it is suspended a forced second run on its branch is refused, naming the run that holds it', async () => {
  const { repo, runId, code, stdout } = await suspendedRun();
  const second = await sail(repo.dir, repo.env, ['FAKE-1', '--force']);
  expect({
    code,
    resume: stdout.split('\n').filter((line) => line.startsWith('resume it with')),
    second: second.code,
    holder: second.stderr.includes(`is leased by run ${runId} (suspended)`),
  }).toEqual({
    code: 2,
    resume: [`resume it with: sail resume ${runId} --raise-budget <usd>`],
    second: 3,
    holder: true,
  });
}, 120_000);

test('sail resume refuses a raise that is not a positive number of dollars with exit 3, and leaves STATUS as it was', async () => {
  const { repo, runId, dir } = await suspendedRun();
  const refusals = [];
  for (const value of ['x', '-1', '0']) {
    const refused = await sail(repo.dir, repo.env, ['resume', runId, `--raise-budget=${value}`]);
    refusals.push([refused.code, refused.stderr.trim()]);
  }
  expect({ refusals, status: status(dir) }).toEqual({
    refusals: [
      [3, "sail resume: --raise-budget takes a positive number of dollars: 'x'"],
      [3, "sail resume: --raise-budget takes a positive number of dollars: '-1'"],
      [3, "sail resume: --raise-budget takes a positive number of dollars: '0'"],
    ],
    status: 'suspended budget_exceeded\n',
  });
}, 120_000);

test('sail resume --raise-budget 5 exits 0, with the raise in the events once', async () => {
  const { dir } = await suspendedRun();
  const resumed = await raisedResume();
  expect({
    code: resumed.code,
    raised: readEvents(dir).filter((event) => event.type === 'budget:raised').length,
    status: status(dir),
  }).toEqual({ code: 0, raised: 1, status: 'completed\n' });
}, 120_000);

test('sail show after the raised resume prints the cost against the raised budget', async () => {
  const { repo, runId } = await suspendedRun();
  await raisedResume();
  const shown = await sail(repo.dir, repo.env, ['show', runId]);
  expect(shown.stdout.split('\n').filter((line) => line.startsWith('cost'))).toEqual([
    expect.stringMatching(/^cost +\$1\.54 of \$5\.50 \(28%\)$/),
  ]);
}, 120_000);

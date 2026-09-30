// `sail runs`, in process through run(): copies of the golden run in a temp repository, beside a `.sail/` with nothing in
// it, since the command never reads project.yaml.
import { expect, test } from 'bun:test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { EXIT_OK, EXIT_REFUSED } from '../../src/cli/exit-codes';
import { copyGoldenRun, emptySailDir, GOLDEN_RUN_ID } from '../helpers/golden-run';
import { runCaptured } from '../helpers/run-captured';
import { withTempRepo } from '../helpers/temp-repo';

const STAGE_RUN = 'tests-01M3D4A2B6C8E0G2J4K6M8P0R2';
const text = (...lines: string[]) => lines.map((line) => `${line}\n`).join('');

test("sail runs prints a row per run, oldest first, and leaves out what isn't a run", async () => {
  await withTempRepo(async (repo) => {
    emptySailDir(repo.dir);
    copyGoldenRun(repo.dir, { status: 'completed\n' });
    copyGoldenRun(repo.dir, {
      runId: 'FAKE-2-01M3C0Q5ZJ3K8T1V9XRJ5KWD3P',
      startedAt: '2026-09-26T10:30:15.250Z',
      status: 'suspended interrupted\n',
    });
    copyGoldenRun(repo.dir, {
      runId: 'FAKE-3-01M3A7H2KQ9V4T6V2XRJ5KWD3M',
      startedAt: '2026-09-24T08:05:09.999Z',
      status: 'failed workflow_failed\n',
    });
    mkdirSync(join(repo.dir, '.sail-runs', STAGE_RUN, '00-tests', 'call-1'), { recursive: true });
    const captured = await runCaptured(['runs'], repo.dir);
    console.log(captured.stdout);
    expect(captured).toEqual({
      code: EXIT_OK,
      stdout: text(
        'run                                workflow        status                  started',
        'FAKE-3-01M3A7H2KQ9V4T6V2XRJ5KWD3M  ticket-to-pr@1  failed workflow_failed  2026-09-24T08:05:09Z',
        'FAKE-1-01M3BWNZM08Q4T6V2XRJ5KWD3N  ticket-to-pr@1  completed               2026-09-25T09:00:00Z',
        'FAKE-2-01M3C0Q5ZJ3K8T1V9XRJ5KWD3P  ticket-to-pr@1  suspended interrupted   2026-09-26T10:30:15Z',
      ),
      stderr: '',
    });
  });
});

test.each<[string, (repoDir: string) => void]>([
  ['there is no .sail-runs/', () => undefined],
  [
    '.sail-runs/ holds only what sail stage run wrote',
    (repoDir) => mkdirSync(join(repoDir, '.sail-runs', STAGE_RUN, '00-tests', 'call-1'), { recursive: true }),
  ],
])('sail runs says there are none when %s', async (_, prepare) => {
  await withTempRepo(async (repo) => {
    emptySailDir(repo.dir);
    prepare(repo.dir);
    expect(await runCaptured(['runs'], repo.dir)).toEqual({
      code: EXIT_OK,
      stdout: 'no runs in .sail-runs\n',
      stderr: '',
    });
  });
});

test("sail runs shows ? for a STATUS it can't read, says why on stderr, and exits 0", async () => {
  await withTempRepo(async (repo) => {
    emptySailDir(repo.dir);
    copyGoldenRun(repo.dir, { status: 'bogus\n' });
    const { code, stdout, stderr } = await runCaptured(['runs'], repo.dir);
    expect({ code, stdout }).toEqual({
      code: EXIT_OK,
      stdout: text(
        'run                                workflow        status  started',
        'FAKE-1-01M3BWNZM08Q4T6V2XRJ5KWD3N  ticket-to-pr@1  ?       2026-09-25T09:00:00Z',
      ),
    });
    expect(stderr).toStartWith(`sail runs: ${GOLDEN_RUN_ID}: `);
    expect(stderr).toContain('STATUS');
  });
});

test('sail runs outside a repository with a .sail/ is refused with exit 3', async () => {
  await withTempRepo(async (repo) => {
    expect(await runCaptured(['runs'], repo.dir)).toEqual({
      code: EXIT_REFUSED,
      stdout: '',
      stderr: `sail runs: no .sail/ between ${repo.dir} and the git root ${repo.dir}\n`,
    });
  });
});

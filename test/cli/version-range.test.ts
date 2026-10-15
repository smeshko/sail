// The `sail` range in project.yaml at run start and at resume: a range the running version misses, or one that isn't a
// range, is refused with exit 3 naming both versions, and leaves nothing behind. `sail check` and `sail stage run` have
// their own tests of this; these cover `sail <ticket>` and `sail resume`. The behaviour is in readConfig(), so these
// were written after it and shown to bite by removing the check.
import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import pkg from '../../package.json';
import { EXIT_OK, EXIT_REFUSED, EXIT_SUSPENDED } from '../../src/cli/exit-codes';
import { copyFixture, edit } from '../helpers/fixture';
import { runCaptured } from '../helpers/run-captured';
import { copyRun, writeStub } from '../helpers/stub-workflow';
import { withTempRepo } from '../helpers/temp-repo';

const DECLARED = '>=0.0.0 <1';
const MISSED = '>=1.0 <2';
const refusal = (range: string) =>
  `.sail/project.yaml  /sail is '${range}', which sail ${pkg.version} doesn't satisfy\n`;

/** Every file under `dir`, by relative path, with its content hash: what a refusal must leave as it was. */
function listing(dir: string): Record<string, string> {
  const files: Record<string, string> = {};
  const walk = (at: string) => {
    for (const name of readdirSync(at).sort()) {
      const path = join(at, name);
      if (statSync(path).isDirectory()) walk(path);
      else files[path.slice(dir.length)] = createHash('sha256').update(readFileSync(path)).digest('hex');
    }
  };
  if (existsSync(dir)) walk(dir);
  return files;
}

test('sail FAKE-1 refuses a sail range the running version misses with exit 3, and starts and claims nothing', async () => {
  await withTempRepo(async (repo) => {
    edit(copyFixture(repo.dir), 'project.yaml', DECLARED, MISSED);
    expect(await runCaptured(['FAKE-1'], repo.dir)).toEqual({
      code: EXIT_REFUSED,
      stdout: '',
      stderr: refusal(MISSED),
    });
    // The fake adapters keep their store in .sail-runs/fake/, so no directory at all means no claim either.
    expect(existsSync(join(repo.dir, '.sail-runs'))).toBe(false);
  });
});

test('sail resume refuses the same range and leaves the run as it was, then resumes once the range is back', async () => {
  await withTempRepo(async (repo) => {
    const runId = await withTempRepo(async (from) => {
      writeStub(from.dir, { testsPassAt: 1 });
      const stopped = await runCaptured(['FAKE-1', '--until', 'spec'], from.dir);
      expect({ code: stopped.code, stderr: stopped.stderr }).toEqual({ code: EXIT_SUSPENDED, stderr: '' });
      copyRun(from.dir, repo.dir);
      return readdirSync(join(from.dir, '.sail-runs')).filter((name) => name !== 'fake')[0] ?? '';
    });
    const sail = join(repo.dir, '.sail');
    const before = listing(join(repo.dir, '.sail-runs'));

    edit(sail, 'project.yaml', DECLARED, MISSED);
    expect(await runCaptured(['resume', runId], repo.dir)).toEqual({
      code: EXIT_REFUSED,
      stdout: '',
      stderr: refusal(MISSED),
    });
    expect(listing(join(repo.dir, '.sail-runs'))).toEqual(before);

    edit(sail, 'project.yaml', MISSED, DECLARED);
    const resumed = await runCaptured(['resume', runId], repo.dir);
    expect({ code: resumed.code, stderr: resumed.stderr }).toEqual({ code: EXIT_OK, stderr: '' });
  });
});

test('sail FAKE-1 refuses a sail that is not a version range, with exit 3', async () => {
  await withTempRepo(async (repo) => {
    edit(copyFixture(repo.dir), 'project.yaml', DECLARED, 'latest');
    expect(await runCaptured(['FAKE-1'], repo.dir)).toEqual({
      code: EXIT_REFUSED,
      stdout: '',
      stderr: ".sail/project.yaml  /sail is 'latest', which is not a version range\n",
    });
    expect(existsSync(join(repo.dir, '.sail-runs'))).toBe(false);
  });
});

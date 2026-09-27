// The stub ticket-to-pr: what it writes type-checks and obeys the layout rules, and its tests stage fails until the call
// its threshold names.
import { expect, test } from 'bun:test';
import { EXIT_FAILED, EXIT_OK } from '../../src/cli/exit-codes';
import { runCaptured } from './run-captured';
import { stubExecutions, writeStub } from './stub-workflow';
import { withTempRepo } from './temp-repo';

test('sail check accepts the stub as written', async () => {
  await withTempRepo(async (repo) => {
    writeStub(repo.dir);
    const checked = await runCaptured(['check'], repo.dir);
    expect(checked.stderr).toBe('');
    expect(checked.code).toBe(EXIT_OK);
    expect(stubExecutions(repo.dir)).toEqual([]);
  });
});

test("the stub's tests stage fails its first call by default, and logs what ran", async () => {
  await withTempRepo(async (repo) => {
    writeStub(repo.dir);
    const ran = await runCaptured(['stage', 'run', '.sail/stages/tests'], repo.dir);
    expect(ran.stdout).toStartWith('tests#1 failed');
    expect(ran.code).toBe(EXIT_FAILED);
    expect(stubExecutions(repo.dir)).toEqual(['tests#1']);
  });
});

test('with testsPassAt 1, the tests stage passes its first call', async () => {
  await withTempRepo(async (repo) => {
    writeStub(repo.dir, { testsPassAt: 1 });
    const ran = await runCaptured(['stage', 'run', '.sail/stages/tests'], repo.dir);
    expect(ran.stdout).toStartWith('tests#1 passed');
    expect(ran.code).toBe(EXIT_OK);
    expect(stubExecutions(repo.dir)).toEqual(['tests#1']);
  });
});

// The stub ticket-to-pr: what it writes type-checks and obeys the layout rules, its tests stage fails until the call
// its threshold names, and the call `sleepAt` names sleeps once, until it is interrupted.
import { expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { EXIT_FAILED, EXIT_OK } from '../../src/cli/exit-codes';
import { fakeInterrupts, runCaptured } from './run-captured';
import { isAlive, stubExecutions, whenSleeping, writeStub } from './stub-workflow';
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

test('the call sleepAt names sleeps on its first run until it is interrupted, and neither of its processes survives', async () => {
  await withTempRepo(async (repo) => {
    writeStub(repo.dir, { sleepAt: 'spec#1' });
    const stage = '.sail/workflows/ticket-to-pr/stages/spec';
    const interrupts = fakeInterrupts();
    const running = runCaptured(['stage', 'run', stage], repo.dir, interrupts);
    const pids = await whenSleeping(repo.dir);
    expect(pids.map(isAlive)).toEqual([true, true]);
    interrupts.interrupt();
    const interrupted = await running;
    expect(interrupted.stdout.split('\n')[1]).toStartWith('  exit_code  interrupted, then ');
    expect(interrupted.code).toBe(EXIT_FAILED);
    expect(pids.map(isAlive)).toEqual([false, false]);
    expect(existsSync(join(repo.dir, '.stub', 'sleep-at'))).toBe(false);

    const again = await runCaptured(['stage', 'run', stage], repo.dir);
    expect(again.stdout).toStartWith('spec#1 passed');
    expect(again.code).toBe(EXIT_OK);
    expect(stubExecutions(repo.dir)).toEqual(['spec#1', 'spec#1']);
  });
});

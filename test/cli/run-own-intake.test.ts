// `sail <ticket> --workflow groom`: a run whose intake is the repository's own, two steps of a script and an agent, run
// as `intake#1` from the run's source before any workflow code, journaled at the head of the journal and replayed like
// the built-in. Each case has a temp repository of its own, because a process opens one run per .sail/.
import { expect, test } from 'bun:test';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { EXIT_FAILED, EXIT_OK, EXIT_SUSPENDED } from '../../src/cli/exit-codes';
import { readJournal } from '../../src/engine/journal';
import type { RunHeader } from '../../src/engine/run-header';
import { formatIssue, validateRunDir } from '../../src/engine/schemas';
import { readEvents } from '../../src/events/consumers/ndjson';
import { copyFixture, type OwnIntakeOptions, seedHarness, writeOwnIntake } from '../helpers/fixture';
import { fakeInterrupts, runCaptured } from '../helpers/run-captured';
import { copyRun } from '../helpers/stub-workflow';
import { withTempRepo } from '../helpers/temp-repo';

const SHAPED = { outcome: 'done', output: { title: 'Groomed FAKE-1' }, messages: ['Titled.'] };

/** A repository with `groom` written, its agent step answering `answer` as `intake/<agent step>`. */
function groomRepo(repoDir: string, options: OwnIntakeOptions = {}, answers: unknown[] = [SHAPED]): string {
  const sail = copyFixture(repoDir);
  writeOwnIntake(sail, options);
  seedHarness(sail, `intake/${options.agentStep ?? 'shape'}`, answers);
  return sail;
}

const runDirOf = (repoDir: string): string => {
  const runs = join(repoDir, '.sail-runs');
  const [id = ''] = readdirSync(runs).filter((name) => name !== 'fake');
  return join(runs, id);
};

const headerOf = (dir: string): RunHeader => JSON.parse(readFileSync(join(dir, 'run.json'), 'utf8'));

test('the repository intake fixture passes preflight without declaring its fetch file again on the last step', async () => {
  await withTempRepo(async (repo) => {
    groomRepo(repo.dir);
    const { code, stderr } = await runCaptured(['FAKE-1', '--workflow', 'groom', '--dry-run'], repo.dir);
    expect({ code, stderr }).toEqual({ code: EXIT_OK, stderr: '' });
    expect(existsSync(join(repo.dir, '.sail-runs'))).toBe(false);
  });
});

test('sail FAKE-1 --workflow groom runs the repository intake as intake#1 and completes with its input and files', async () => {
  await withTempRepo(async (repo) => {
    groomRepo(repo.dir);
    const { code, stderr, stdout } = await runCaptured(['FAKE-1', '--workflow', 'groom'], repo.dir);
    expect({ code, stderr, stdout: code === EXIT_OK ? '' : stdout }).toEqual({ code: EXIT_OK, stderr: '', stdout: '' });
    const dir = runDirOf(repo.dir);

    expect(readFileSync(join(dir, 'STATUS'), 'utf8').trim()).toBe('completed');
    const { entries } = readJournal(dir);
    expect(entries.map((entry) => `${entry.key} ${entry.outcome}`)).toEqual([
      'intake#1 done',
      'echo#1 passed',
      'echo#2 passed',
    ]);
    expect(readdirSync(join(dir, '00-intake', 'call-1', 'steps')).sort()).toEqual([
      expect.stringContaining('fetch'),
      expect.stringContaining('shape'),
    ]);
    expect(existsSync(join(dir, '00-intake', 'call-1', 'result.json'))).toBe(true);
    expect(entries[0]?.files['brief.md']).toMatch(/^00-intake\/call-1\/brief\.md$/);
    expect(existsSync(join(dir, entries[0]?.files['brief.md'] ?? ''))).toBe(true);

    const events = readEvents(dir);
    const end = events.find((event) => event.type === 'run:end');
    expect(end).toMatchObject({
      status: 'completed',
      result: { title: 'Groomed FAKE-1', brief: '# Brief for FAKE-1' },
    });
    const start = events.filter((event) => event.type === 'intake:start');
    expect(start).toEqual([
      expect.objectContaining({
        key: 'intake#1',
        intake: 'groom',
        kind: 'stage',
        steps: ['fetch', 'shape'],
        origin: 'repo:.sail/workflows/groom/intake.ts',
        consumed: { source: 'run.json#/source' },
      }),
    ]);
    expect(events.filter((event) => event.type === 'intake:end')).toEqual([
      expect.objectContaining({ key: 'intake#1', outcome: 'done' }),
    ]);
    expect(validateRunDir(dir).issues.map(formatIssue)).toEqual([]);
  });
});

test("the run's roster records the intake's steps and where its folder is", async () => {
  await withTempRepo(async (repo) => {
    groomRepo(repo.dir);
    await runCaptured(['FAKE-1', '--workflow', 'groom'], repo.dir);
    const dir = runDirOf(repo.dir);
    const { intake } = headerOf(dir);
    expect(intake.name).toBe('groom');
    expect(intake.origin).toBe('repo:.sail/workflows/groom/intake.ts');
    expect(intake.steps?.map((step) => step.step)).toEqual(['fetch', 'shape']);
    expect(existsSync(join(dir, 'definition', '.sail', 'workflows', 'groom', 'fetch.sh'))).toBe(true);
  });
});

test('sail show lists intake#1 with both of its steps, then echo#1', async () => {
  await withTempRepo(async (repo) => {
    groomRepo(repo.dir);
    await runCaptured(['FAKE-1', '--workflow', 'groom'], repo.dir);
    const shown = await runCaptured(['show', 'FAKE-1'], repo.dir);
    expect(shown.code).toBe(EXIT_OK);
    const rows = shown.stdout.split('\n').map((line) => line.trim().split(/\s+/));
    const row = (key: string) => rows.find((cells) => cells[0] === key);
    expect(row('intake#1')).toContain('done');
    expect(row('intake#1/fetch')).toEqual(expect.arrayContaining(['script', 'passed']));
    expect(row('intake#1/shape')).toEqual(expect.arrayContaining(['agent', 'done']));
    expect(row('echo#1')).toContain('passed');
    expect(shown.stdout).toMatch(/\n {2}intake#1\/fetch/);
    const keys = rows.map((cells) => cells[0]);
    expect(keys.indexOf('intake#1/fetch')).toBe(keys.indexOf('intake#1') + 1);
    expect(keys.indexOf('echo#1')).toBeGreaterThan(keys.indexOf('intake#1/shape'));
  });
});

const FAILURES = [
  {
    name: 'a script step that fails',
    options: { fetchExit: 1 },
    answers: [SHAPED],
    outcome: 'failed',
    tail: /ended in failed: /,
  },
  {
    name: 'an agent step that blocks',
    options: { agentStep: 'refuse' },
    answers: [{ outcome: 'blocked', reason: 'the ticket says nothing' }],
    outcome: 'blocked',
    tail: /ended in blocked: the ticket says nothing/,
  },
  {
    name: 'an agent step whose output the schema refuses, on both tries',
    options: { agentStep: 'misfit' },
    answers: [
      { outcome: 'done', output: { title: 7 } },
      { outcome: 'done', output: { title: 7 } },
    ],
    outcome: 'error',
    tail: /ended in error: invalid_output: the output doesn't match its schema:[\s\S]*at title/,
  },
];

for (const failure of FAILURES) {
  test(`${failure.name} fails the run with stage_error naming the intake, and leaves intake#1's result.json`, async () => {
    await withTempRepo(async (repo) => {
      groomRepo(repo.dir, failure.options, failure.answers);
      const { code, stderr } = await runCaptured(['FAKE-1', '--workflow', 'groom'], repo.dir);
      expect({ code, stderr }).toEqual({ code: EXIT_FAILED, stderr: '' });
      const dir = runDirOf(repo.dir);
      const end = readEvents(dir).find((event) => event.type === 'run:end');
      expect(end).toMatchObject({ status: 'failed', stopReason: 'stage_error' });
      const message = (end as { message: string }).message;
      expect(message).toStartWith("the intake 'groom' (intake#1) ended in ");
      expect(message).toMatch(failure.tail);
      expect(readJournal(dir).entries.map((entry) => `${entry.key} ${entry.outcome}`)).toEqual([
        `intake#1 ${failure.outcome}`,
      ]);
      const result = JSON.parse(readFileSync(join(dir, '00-intake', 'call-1', 'result.json'), 'utf8'));
      expect(result.outcome).toBe(failure.outcome);
    });
  });
}

test('sail FAKE-1 --workflow groom --until echo then sail resume completes with one intake#1 journal line and one intake:start', async () => {
  await withTempRepo(async (repo) => {
    const dir = await withTempRepo(async (from) => {
      groomRepo(from.dir);
      const stopped = await runCaptured(['FAKE-1', '--workflow', 'groom', '--until', 'echo'], from.dir);
      expect(stopped.code).toBe(EXIT_SUSPENDED);
      copyRun(from.dir, repo.dir);
      return runDirOf(repo.dir);
    });
    const resumed = await runCaptured(['resume', basename(dir)], repo.dir);
    expect({ code: resumed.code, stderr: resumed.stderr }).toEqual({ code: EXIT_OK, stderr: '' });
    expect(readJournal(dir).entries.map((entry) => entry.key)).toEqual(['intake#1', 'echo#1', 'echo#2']);
    const events = readEvents(dir);
    expect(events.filter((event) => event.type === 'intake:start')).toHaveLength(1);
    expect(
      events.filter((event) => event.type === 'run:end').map((event) => (event as { status: string }).status),
    ).toEqual(['suspended', 'completed']);
  });
});

test('a run interrupted during the intake journals nothing, and sail resume runs the intake again and journals one intake#1', async () => {
  await withTempRepo(async (repo) => {
    await withTempRepo(async (from) => {
      groomRepo(from.dir, {}, [{ ...SHAPED, delayMs: 30_000 }]);
      const interrupts = fakeInterrupts();
      const running = runCaptured(['FAKE-1', '--workflow', 'groom'], from.dir, interrupts);
      const marker = join(from.dir, '.stub', 'executions.log');
      const deadline = performance.now() + 20_000;
      while (!existsSync(marker) && performance.now() < deadline) await Bun.sleep(20);
      await Bun.sleep(300);
      interrupts.interrupt();
      const stopped = await running;
      expect(stopped.code).toBe(EXIT_SUSPENDED);
      expect(readJournal(runDirOf(from.dir)).entries).toEqual([]);
      copyRun(from.dir, repo.dir);
    });
    const dir = runDirOf(repo.dir);
    seedHarness(join(repo.dir, '.sail'), 'intake/shape', [SHAPED]);
    const resumed = await runCaptured(['resume', basename(dir)], repo.dir);
    expect({ code: resumed.code, stderr: resumed.stderr }).toEqual({ code: EXIT_OK, stderr: '' });
    expect(readJournal(dir).entries.map((entry) => `${entry.key} ${entry.outcome}`)).toEqual([
      'intake#1 done',
      'echo#1 passed',
      'echo#2 passed',
    ]);
    expect(validateRunDir(dir).issues.map(formatIssue)).toEqual([]);
  });
});

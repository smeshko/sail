import { expect, test } from 'bun:test';
import { cpSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import pkg from '../../package.json' with { type: 'json' };
import { readJournal } from '../../src/engine/journal';
import { edit } from '../helpers/fixture';
import { interruptWhenAsleep, stubExecutions, writeStub } from '../helpers/stub-workflow';
import { withTempRepo } from '../helpers/temp-repo';

const shim = join(import.meta.dir, '..', '..', 'src', 'cli', 'main.ts');

test('bun runs the shim from another directory', async () => {
  await withTempRepo((repo) => {
    const result = Bun.spawnSync([process.execPath, shim, '--version'], { cwd: repo.dir, env: repo.env });
    expect(result.stdout.toString()).toBe(`${pkg.version}\n`);
    expect(result.exitCode).toBe(0);
  });
});

test('the shim runs directly through its shebang', async () => {
  await withTempRepo((repo) => {
    const result = Bun.spawnSync([shim, '--version'], { cwd: repo.dir, env: repo.env });
    expect(result.stdout.toString()).toBe(`${pkg.version}\n`);
    expect(result.exitCode).toBe(0);
  });
});

test('the shim exits with the code run() returns', async () => {
  await withTempRepo((repo) => {
    const result = Bun.spawnSync([process.execPath, shim, '--bogus'], { cwd: repo.dir, env: repo.env });
    expect(result.stderr.toString()).toContain("unknown argument '--bogus'");
    expect(result.exitCode).toBe(3);
  });
});

test('the shim runs check: 0 on a fixture copy, 3 once a binding is wrongly wired', async () => {
  await withTempRepo((repo) => {
    const sail = join(repo.dir, '.sail');
    cpSync(join(import.meta.dir, '..', 'fixtures', 'repo', '.sail'), sail, { recursive: true });
    const check = () => Bun.spawnSync([process.execPath, shim, 'check'], { cwd: repo.dir, env: repo.env });

    const passing = check();
    expect(passing.stdout.toString()).toBe('.sail/ checked: 1 workflow, 5 stages\n');
    expect(passing.exitCode).toBe(0);

    const workflow = join(sail, 'workflows', 'ticket-to-pr', 'workflow.ts');
    writeFileSync(
      workflow,
      readFileSync(workflow, 'utf8').replace("s.files['spec.md'], feedback", 'run.input, feedback'),
    );
    const failing = check();
    expect(failing.stderr.toString()).toContain('.sail/workflows/ticket-to-pr/workflow.ts:');
    expect(failing.stderr.toString()).toContain('TS2739');
    expect(failing.exitCode).toBe(3);
  });
});

test('the shim runs a workflow through a pipe in plain mode, with no escape byte, and exits 0 when the run completes', async () => {
  await withTempRepo((repo) => {
    writeStub(repo.dir);
    const result = Bun.spawnSync([process.execPath, shim, 'run'], { cwd: repo.dir, env: repo.env });
    const stdout = result.stdout.toString();
    expect(stdout).toMatch(/^sail · ticket-to-pr v1 · LOCAL-[0-9A-Z]{26}\n/);
    expect(stdout).toMatch(/\ncompleted · [^\n]+\n {2}calls {4}7 · 6 passed, 1 failed\n/);
    expect(stdout.includes('\x1b')).toBe(false);
    expect(result.exitCode).toBe(0);
  });
});

// In a process of its own, because bun test fails a test on any unhandled rejection, whatever the process listens for.
test("a run.fail() in a chain the workflow doesn't await, after the run has ended, changes neither its end nor its code", async () => {
  await withTempRepo((repo) => {
    const sail = writeStub(repo.dir);
    edit(
      sail,
      'workflows/ticket-to-pr/workflow.ts',
      '  return run.stage(publish',
      `  // Nothing awaits this chain, and its run.fail() comes after every replay has ended.
  void (async () => {
    for (let tick = 0; tick < 20; tick++) await null;
    run.fail('too late');
  })();
  return run.stage(publish`,
    );
    const result = Bun.spawnSync([process.execPath, shim, 'run'], { cwd: repo.dir, env: repo.env });
    const [runId = ''] = readdirSync(join(repo.dir, '.sail-runs'));
    expect(readFileSync(join(repo.dir, '.sail-runs', runId, 'STATUS'), 'utf8')).toBe('completed\n');
    expect(result.stderr.toString()).toBe('');
    expect(result.exitCode).toBe(0);
  });
});

// A real signal through the shim: the test sends it to the spawned bin, never to its own process.
test.each(['SIGINT', 'SIGTERM'] as const)(
  '%s during sail run suspends the run, and sail resume runs it to its end, both in plain mode',
  async (signal) => {
    await withTempRepo(async (repo) => {
      writeStub(repo.dir, { sleepAt: 'implement#2' });
      const sail = Bun.spawn([process.execPath, shim, 'run'], {
        cwd: repo.dir,
        env: repo.env,
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const { end: code, alive } = await interruptWhenAsleep(repo.dir, sail.exited, () => sail.kill(signal));
      const [runId = ''] = readdirSync(join(repo.dir, '.sail-runs'));
      const dir = join(repo.dir, '.sail-runs', runId);
      const suspended = await new Response(sail.stdout).text();
      expect(suspended).toContain('\n  stop     interrupted: stopped during implement#2\n');
      expect(suspended).toEndWith(`  run      .sail-runs/${runId}\nresume it with: sail resume ${runId}\n`);
      expect(suspended.includes('\x1b')).toBe(false);
      expect(await new Response(sail.stderr).text()).toBe('');
      expect(code).toBe(2);
      expect(alive).toEqual([]);
      expect(readFileSync(join(dir, 'STATUS'), 'utf8')).toBe('suspended interrupted\n');

      const resumed = Bun.spawnSync([process.execPath, shim, 'resume', runId], { cwd: repo.dir, env: repo.env });
      const resumedOut = resumed.stdout.toString();
      expect(resumedOut).toStartWith(
        `sail · ticket-to-pr v1 · ${runId} · resumed after 3 calls, last tests#1 failed\n`,
      );
      expect(resumedOut).toEndWith(`  run      .sail-runs/${runId}\n`);
      expect(resumedOut.includes('\x1b')).toBe(false);
      expect(resumed.exitCode).toBe(0);
      expect(stubExecutions(repo.dir)).toEqual([
        'spec#1',
        'implement#1',
        'tests#1',
        'implement#2',
        'implement#2',
        'tests#2',
        'self-review#1',
        'publish#1',
      ]);
      expect(readJournal(dir).entries.map((entry) => entry.key)).toEqual([
        'spec#1',
        'implement#1',
        'tests#1',
        'implement#2',
        'tests#2',
        'self-review#1',
        'publish#1',
      ]);
    });
  },
  60_000,
);

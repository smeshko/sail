import { expect, test } from 'bun:test';
import { cpSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import pkg from '../../package.json' with { type: 'json' };
import { edit } from '../helpers/fixture';
import { writeStub } from '../helpers/stub-workflow';
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

test('the shim runs a workflow and exits with its code: 0 when the run completes', async () => {
  await withTempRepo((repo) => {
    writeStub(repo.dir);
    const result = Bun.spawnSync([process.execPath, shim, 'run'], { cwd: repo.dir, env: repo.env });
    expect(result.stdout.toString()).toContain('publish#1 passed\n');
    expect(result.stdout.toString()).toMatch(/LOCAL-[0-9A-Z]{26} completed {2}\.sail-runs\/LOCAL-/);
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
    expect(result.stdout.toString()).toMatch(/LOCAL-[0-9A-Z]{26} completed {2}\.sail-runs\/LOCAL-/);
    expect(result.stderr.toString()).toBe('');
    expect(result.exitCode).toBe(0);
  });
});

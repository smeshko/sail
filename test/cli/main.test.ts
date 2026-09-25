import { expect, test } from 'bun:test';
import { join } from 'node:path';
import pkg from '../../package.json' with { type: 'json' };
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

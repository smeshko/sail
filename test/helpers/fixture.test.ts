import { expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { EXIT_SUSPENDED } from '../../src/cli/exit-codes';
import { runDirIn } from './agent-fixture';
import { commitGreet, copyFixture } from './fixture';
import { runCaptured } from './run-captured';
import { withTempRepo } from './temp-repo';

test('commitGreet commits src/greet.ts on main and leaves the working tree clean', async () => {
  await withTempRepo(async (repo) => {
    commitGreet(repo);
    expect(repo.git('show', 'main:src/greet.ts')).toContain('usage: greet <name>');
    expect(repo.git('status', '--porcelain').trim()).toBe('');
  });
});

test('the committed greet prints Hello, Ada! and a usage line on --help', async () => {
  await withTempRepo(async (repo) => {
    commitGreet(repo);
    const run = (...args: string[]) =>
      Bun.spawnSync(['bun', 'src/greet.ts', ...args], { cwd: repo.dir, env: repo.env }).stdout.toString();
    expect(run('Ada').trim()).toBe('Hello, Ada!');
    expect(run('--help')).toContain('usage: greet <name>');
  });
});

test('a sail FAKE-1 --until spec run on a repository given commitGreet has src/greet.ts in its workspace', async () => {
  await withTempRepo(async (repo) => {
    copyFixture(repo.dir);
    commitGreet(repo);
    const ran = await runCaptured(['FAKE-1', '--until', 'spec', '-q'], repo.dir, { env: repo.env });
    expect(ran.code).toBe(EXIT_SUSPENDED);
    expect(existsSync(join(runDirIn(repo.dir), 'workspace', 'src', 'greet.ts'))).toBe(true);
  });
});

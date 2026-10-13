// bin/sail, run as a process through its shebang: the `sail` a script step finds first on its PATH. It execs this
// checkout's CLI on the Bun `SAIL_BUN` names, or on the `bun` on PATH. Every spawn takes an explicit environment: Bun
// spawns don't see a mutated process.env.
import { expect, test } from 'bun:test';
import { mkdirSync, statSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import pkg from '../../package.json' with { type: 'json' };
import { withTempRepo } from '../helpers/temp-repo';

const BIN = join(import.meta.dir, '..', '..', 'bin', 'sail');
const SYSTEM_PATH = '/usr/bin:/bin';

/** Runs `bin/sail <args>` from `cwd` in `env`, and gives what it printed and its exit code. */
function sail(args: string[], cwd: string, env: Record<string, string>) {
  const child = Bun.spawnSync([BIN, ...args], { cwd, env, stdout: 'pipe', stderr: 'pipe' });
  return { code: child.exitCode, stdout: child.stdout.toString(), stderr: child.stderr.toString() };
}

test('bin/sail is executable, and with SAIL_BUN naming the running Bun and no bun on PATH it prints the version and exits 0', async () => {
  await withTempRepo((repo) => {
    const env = { HOME: repo.home, PATH: SYSTEM_PATH, SAIL_BUN: process.execPath };
    expect(sail(['--version'], repo.dir, env)).toEqual({ code: 0, stdout: `${pkg.version}\n`, stderr: '' });
    expect(statSync(BIN).mode & 0o111).toBe(0o111);
  });
});

test('without SAIL_BUN it runs the bun it finds on PATH', async () => {
  await withTempRepo((repo) => {
    // A directory holding only `bun`, whatever the running Bun's own file is called.
    const tools = join(repo.home, 'tools');
    mkdirSync(tools);
    symlinkSync(process.execPath, join(tools, 'bun'));
    const env = { HOME: repo.home, PATH: `${tools}:${SYSTEM_PATH}` };
    expect(sail(['--version'], repo.dir, env)).toEqual({ code: 0, stdout: `${pkg.version}\n`, stderr: '' });
  });
});

test("its arguments reach the CLI unchanged, spaces included, and its exit code and message are the CLI's own", async () => {
  await withTempRepo((repo) => {
    const env = { HOME: repo.home, PATH: SYSTEM_PATH, SAIL_BUN: process.execPath };
    const usage = "Run 'sail --help' for usage.\n";
    expect(sail(['nonsense', '--flag'], repo.dir, env)).toEqual({
      code: 3,
      stdout: '',
      stderr: `sail: unknown argument '--flag'\n${usage}`,
    });
    expect(sail(['check', 'two words', 'three'], repo.dir, env)).toEqual({
      code: 3,
      stdout: '',
      stderr: `sail: unknown argument 'two words'\n${usage}`,
    });
  });
});

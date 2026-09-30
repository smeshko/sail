import { expect, test } from 'bun:test';
import pkg from '../../package.json' with { type: 'json' };
import { EXIT_INTERNAL, EXIT_OK, EXIT_REFUSED } from '../../src/cli/exit-codes';
import { type Io, run } from '../../src/cli/index';
import { runCaptured } from '../helpers/run-captured';

test('--version prints the package version', async () => {
  expect(await runCaptured(['--version'])).toEqual({ code: EXIT_OK, stdout: `${pkg.version}\n`, stderr: '' });
});

test.each([[[]], [['--help']], [['-h']]])('%p prints usage', async (argv) => {
  const { code, stdout, stderr } = await runCaptured(argv);
  expect(code).toBe(EXIT_OK);
  expect(stdout).toContain('sail check [--list]');
  expect(stdout).toContain('sail stage run <stage-dir> [--bind name=value]...');
  expect(stdout).toContain('sail run [--workflow <name>] [--input <json>]');
  expect(stdout).toContain('--version');
  expect(stdout).toContain('--help');
  expect(stderr).toBe('');
});

test('the usage lists sail resume', async () => {
  const { stdout } = await runCaptured(['--help']);
  expect(stdout).toContain('sail resume <run> [--input <json>]');
});

test('the usage lists -q, -v and -vv on run and resume, and what each prints', async () => {
  const { stdout } = await runCaptured(['--help']);
  expect(stdout).toContain('sail run [--workflow <name>] [--input <json>] [-q|-v|-vv]');
  expect(stdout).toContain('sail resume <run> [--input <json>] [-q|-v|-vv]');
  expect(stdout).toContain('Output of run and resume:');
  expect(stdout).toMatch(/-q, --quiet:? +[Oo]nly the run's start, its errors and the final block\n/);
  expect(stdout).toMatch(
    /-v, --verbose:? +[Aa]dds contract details, routes and every script's output tail; -vv prints every event\n/,
  );
});

test('the usage lists sail runs', async () => {
  const { stdout } = await runCaptured(['--help']);
  expect(stdout).toMatch(/^ {2}sail runs {2,}List the runs in \.sail-runs\/$/m);
});

test('the usage lists sail show', async () => {
  const { stdout } = await runCaptured(['--help']);
  expect(stdout).toMatch(
    /^ {2}sail show <run> \[--events\|--follow\|--rebuild\].* {2,}Show a run's calls, loops, routes and totals$/m,
  );
});

test.each([
  [['--bogus'], '--bogus'],
  [['--version', 'extra'], 'extra'],
  [['--help', '--version'], '--version'],
  [['check', '--bogus'], '--bogus'],
  [['check', '--list', 'extra'], 'extra'],
])('%p is refused with exit 3', async (argv, bad) => {
  const { code, stdout, stderr } = await runCaptured(argv);
  expect(code).toBe(EXIT_REFUSED);
  expect(stdout).toBe('');
  expect(stderr).toBe(`sail: unknown argument '${bad}'\nRun 'sail --help' for usage.\n`);
});

test('a value given to a flag is refused with exit 3', async () => {
  expect(await runCaptured(['check', '--list=yes'])).toEqual({
    code: EXIT_REFUSED,
    stdout: '',
    stderr: "sail: option '--list' takes no value\nRun 'sail --help' for usage.\n",
  });
});

test('a command that throws exits 4 and names the error', async () => {
  let stderr = '';
  const io: Io = {
    cwd: process.cwd(),
    stdout: () => {
      throw new Error('stdout closed');
    },
    stderr: (text) => {
      stderr += text;
    },
  };
  expect(await run(['--version'], io)).toBe(EXIT_INTERNAL);
  expect(stderr).toStartWith('sail: internal error: stdout closed\n');
  expect(stderr).toContain('at ');
});

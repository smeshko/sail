import { expect, test } from 'bun:test';
import pkg from '../../package.json' with { type: 'json' };
import { type Io, run } from '../../src/cli/index';

async function runCaptured(argv: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  let stdout = '';
  let stderr = '';
  const io: Io = {
    stdout: (text) => {
      stdout += text;
    },
    stderr: (text) => {
      stderr += text;
    },
  };
  const code = await run(argv, io);
  return { code, stdout, stderr };
}

test('--version prints the package version', async () => {
  expect(await runCaptured(['--version'])).toEqual({ code: 0, stdout: `${pkg.version}\n`, stderr: '' });
});

test.each([[[]], [['--help']], [['-h']]])('%p prints usage', async (argv) => {
  const { code, stdout, stderr } = await runCaptured(argv);
  expect(code).toBe(0);
  expect(stdout).toContain('--version');
  expect(stdout).toContain('--help');
  expect(stderr).toBe('');
});

test.each([
  [['--bogus'], '--bogus'],
  [['--version', 'extra'], 'extra'],
  [['--help', '--version'], '--version'],
])('%p is refused with exit 3', async (argv, bad) => {
  const { code, stdout, stderr } = await runCaptured(argv);
  expect(code).toBe(3);
  expect(stdout).toBe('');
  expect(stderr).toBe(`sail: unknown argument '${bad}'\nRun 'sail --help' for usage.\n`);
});

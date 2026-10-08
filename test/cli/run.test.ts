import { expect, test } from 'bun:test';
import pkg from '../../package.json' with { type: 'json' };
import { EXIT_INTERNAL, EXIT_OK, EXIT_REFUSED } from '../../src/cli/exit-codes';
import { type Io, run } from '../../src/cli/index';
import { type Captured, runCaptured } from '../helpers/run-captured';

test('--version prints the package version', async () => {
  expect(await runCaptured(['--version'])).toEqual({ code: EXIT_OK, stdout: `${pkg.version}\n`, stderr: '' });
});

test.each([[[]], [['--help']], [['-h']]])('%p prints usage', async (argv) => {
  const { code, stdout, stderr } = await runCaptured(argv);
  expect(code).toBe(EXIT_OK);
  expect(stdout).toContain('sail check [--list]');
  expect(stdout).toContain('sail stage run <stage-dir> [--bind name=value]...');
  expect(stdout).toContain('--version');
  expect(stdout).toContain('--help');
  expect(stderr).toBe('');
});

test('the usage lists sail resume', async () => {
  const { stdout } = await runCaptured(['--help']);
  expect(stdout).toMatch(/^ {2}sail resume <run> .* {2,}Resume a suspended or crashed run$/m);
});

test('the usage says what -q, -v and -vv print', async () => {
  const { stdout } = await runCaptured(['--help']);
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

test('the usage lists -q, -v and -vv on sail show', async () => {
  const { stdout } = await runCaptured(['--help']);
  expect(stdout).toContain('sail show <run> [--events|--follow|--rebuild] [-q|-v|-vv]');
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

// `sail <ticket>` (D1): the first argument that names no command is the ticket a run starts from.

const TICKET_USAGE = 'sail <ticket> [--workflow <name>] [--force] [--until <stage>] [-q|-v|-vv]';

// biome-ignore format: TDD-PENDING TASK-007
test
  .skip // TDD-PENDING TASK-007
  ('the usage lists sail <ticket> first among the commands, and says what --force and --until do, each on a line of its own', async () => {
  const { stdout } = await runCaptured(['--help']);
  const commands = stdout.split('\n').filter((line) => line.startsWith('  sail '));
  expect(commands[0]).toBe(`  ${TICKET_USAGE}`);
  expect(stdout).toMatch(/^ {2}--force {2,}\S.*designated.*unstarted/m);
  expect(stdout).toMatch(/^ {2}--until <stage> {2,}\S.*first call.*sail resume/m);
});

// biome-ignore format: TDD-PENDING TASK-007
test
  .skip // TDD-PENDING TASK-007
  ('an argument after the ticket that sail <ticket> does not take is refused by name with exit 3, before anything is looked for', async () => {
  const refused = (bad: string): Captured => ({
    code: EXIT_REFUSED,
    stdout: '',
    stderr: `sail: unknown argument '${bad}'\nRun 'sail --help' for usage.\n`,
  });
  expect(await runCaptured(['FAKE-1', 'extra'])).toEqual(refused('extra'));
  expect(await runCaptured(['FAKE-1', '--bogus'])).toEqual(refused('--bogus'));
  // The ticket comes first: an option ahead of it is no command.
  expect(await runCaptured(['--force', 'FAKE-1'])).toEqual(refused('--force'));
});

// biome-ignore format: TDD-PENDING TASK-011
test
  .skip // TDD-PENDING TASK-011
  ('the usage names neither sail run nor --input: a run starts from a ticket, and a resume takes a run and how much to print', async () => {
  const { stdout } = await runCaptured(['--help']);
  expect([stdout.includes('sail run '), stdout.includes('--input')]).toEqual([false, false]);
  expect(stdout).toMatch(/^ {2}sail resume <run> \[-q\|-v\|-vv\] {2,}Resume a suspended or crashed run$/m);
  expect(stdout).toContain('\nOutput of a run and a resume:\n');
});

test('the usage lists sail port ticket-source and its three operations', async () => {
  const { stdout } = await runCaptured(['--help']);
  expect(stdout).toContain('\n  sail port ticket-source get|links|attachments <ticket>  ');
});

test('the usage lists sail port render', async () => {
  const { stdout } = await runCaptured(['--help']);
  expect(stdout).toContain('\n  sail port render --untrusted --source <text> [--inline]  ');
});

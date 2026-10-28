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

test('the usage lists sail <ticket> first among the commands, and says what --force and --until do, each on a line of its own', async () => {
  const { stdout } = await runCaptured(['--help']);
  const commands = stdout.split('\n').filter((line) => line.startsWith('  sail '));
  expect(commands[0]).toBe(`  ${TICKET_USAGE}`);
  expect(stdout).toMatch(/^ {2}--force {2,}\S.*designated.*pick-up state/m);
  expect(stdout).toMatch(/^ {2}--until <stage> {2,}\S.*first call.*sail resume/m);
});

test('an argument after the ticket that sail <ticket> does not take is refused by name with exit 3, before anything is looked for', async () => {
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

test('the usage names no --input: a run starts from a ticket, and a resume takes a run and how much to print', async () => {
  const { stdout } = await runCaptured(['--help']);
  expect(stdout.includes('--input')).toBe(false);
  expect(stdout).toMatch(/^ {2}sail resume <run> \[-q\|-v\|-vv\] {2,}Resume a suspended or crashed run$/m);
  expect(stdout).toContain('\nOutput of a run and a resume:\n');
});

test('the usage lists sail init', async () => {
  const { stdout } = await runCaptured(['--help']);
  expect(stdout).toMatch(/^ {2}sail init {2,}Write \.sail\/ here: /m);
});

test('the usage lists sail port ticket-source and its three operations', async () => {
  const { stdout } = await runCaptured(['--help']);
  expect(stdout).toContain('\n  sail port ticket-source get|links|attachments <ticket>  ');
});

test('the usage lists sail port ticket-source update and the moves it takes', async () => {
  const { stdout } = await runCaptured(['--help']);
  expect(stdout).toMatch(
    /^ {2}sail port ticket-source update <ticket> --state <unstarted\|in-progress\|in-review\|done\|canceled>\n {10,}Move a ticket/m,
  );
});

test('the usage lists sail port codehost, by its operation', async () => {
  const { stdout } = await runCaptured(['--help']);
  expect(stdout).toContain('\n  sail port codehost <operation> [arguments]  ');
});

test('the usage lists sail port render', async () => {
  const { stdout } = await runCaptured(['--help']);
  expect(stdout).toContain('\n  sail port render --untrusted --source <text> [--inline]  ');
});

test('the usage lists sail stop, saying when a run stops', async () => {
  const { stdout } = await runCaptured(['--help']);
  expect(stdout).toMatch(
    /^ {2}sail stop <run> {2,}Stop a run: at its next call boundary while it runs, at once when it is suspended$/m,
  );
});

test('the usage lists sail queue: ls and poll, add with --force, requeue and drop', async () => {
  const { stdout } = await runCaptured(['--help']);
  expect(stdout).toMatch(/^ {2}sail queue ls\|poll <workflow> {2,}\S/m);
  expect(stdout).toMatch(/^ {2}sail queue add <workflow> <ticket> \[--force\] {2,}\S/m);
  expect(stdout).toMatch(/^ {2}sail queue requeue\|drop <workflow> <item> {2,}\S/m);
});

test("the usage lists sail watch and sail unwatch, and not --dispatch, which is the watcher's", async () => {
  const { stdout } = await runCaptured(['--help']);
  expect(stdout).toMatch(
    /^ {2}sail watch <workflow>\.\.\. {2,}Watch these workflows: start this repository's watcher, or add them to it$/m,
  );
  expect(stdout).toMatch(
    /^ {2}sail unwatch <workflow>\.\.\. {2,}Stop watching them\. The watcher exits when it watches none$/m,
  );
  expect(stdout).not.toContain('--dispatch');
});

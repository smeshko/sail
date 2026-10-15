// `sail dashboard [--port N]`, in process through run(): it serves in the foreground until the interrupt, and refuses a
// port it can't take with exit code 3. The registry is a temporary SAIL_HOME's, and every server binds a free port.
import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EXIT_OK, EXIT_REFUSED, type ExitCode } from '../../src/cli/exit-codes';
import { type Io, run } from '../../src/cli/index';
import { fakeInterrupts, runCaptured } from '../helpers/run-captured';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function sailHome(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'sail-home-')));
  dirs.push(dir);
  return dir;
}

/** Resolves with `value` after `ms`, so a command that never returns fails an assertion instead of the test timing out. */
const after = <T>(ms: number, value: T) => Bun.sleep(ms).then(() => value);

/** Whether anything accepts a connection on 127.0.0.1:`port`. */
const listening = (port: number) =>
  Bun.connect({ hostname: '127.0.0.1', port, socket: { data() {} } }).then(
    (socket) => {
      socket.end();
      return true;
    },
    () => false,
  );

test('sail dashboard --port 0 prints its URL and the registry it reads, serves it, and Ctrl-C ends it with 0 and frees the port', async () => {
  const home = sailHome();
  let stdout = '';
  let stderr = '';
  const interrupts = fakeInterrupts();
  const io: Io = {
    cwd: home,
    stdout: (text) => {
      stdout += text;
    },
    stderr: (text) => {
      stderr += text;
    },
    env: { SAIL_HOME: home },
    onInterrupt: interrupts.onInterrupt as NonNullable<Io['onInterrupt']>,
  };
  let returned = false;
  const running = run(['dashboard', '--port', '0'], io).finally(() => {
    returned = true;
  });
  const deadline = Date.now() + 5000;
  while (!stdout.includes('Ctrl-C stops it\n') && !returned && Date.now() < deadline) await Bun.sleep(10);
  const [first = '', second] = stdout.split('\n');
  expect(first).toMatch(/^sail dashboard: http:\/\/127\.0\.0\.1:[1-9][0-9]*$/);
  expect(second).toBe(`reading the registry in ${join(home, 'watchers')}; Ctrl-C stops it`);
  const url = first.slice('sail dashboard: '.length);
  const answer = await fetch(`${url}/api/repos`, { headers: { 'X-Sail-Dashboard': '1' } });
  expect([answer.status, await answer.json()]).toEqual([200, { repos: [], problems: [] }]);
  interrupts.interrupt();
  expect(await Promise.race([running, after(5000, 'still running')])).toBe(EXIT_OK);
  expect(stderr).toBe('');
  expect(await listening(Number(new URL(url).port))).toBe(false);
}, 15_000);

test.each(['70000', '65536', '-1', 'abc', '1.5', '', '0x50'])(
  '--port %p is refused with exit 3',
  async (port) => {
    const { code, stdout, stderr } = await runCaptured(['dashboard', `--port=${port}`], sailHome(), {
      env: { SAIL_HOME: sailHome() },
      onInterrupt: fakeInterrupts().onInterrupt,
    });
    expect({ code, stdout, stderr }).toEqual({
      code: EXIT_REFUSED,
      stdout: '',
      stderr: 'sail dashboard: --port takes a port number, 0 to 65535\n',
    });
  },
  15_000,
);

test('a port in use is refused with exit 3, naming the port', async () => {
  const holder = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('held') });
  try {
    const home = sailHome();
    const ran = runCaptured(['dashboard', '--port', String(holder.port)], home, {
      env: { SAIL_HOME: home },
      onInterrupt: fakeInterrupts().onInterrupt,
    });
    const ended = await Promise.race([ran, after(5000, undefined)]);
    expect(ended?.code).toBe(EXIT_REFUSED);
    expect(ended?.stdout).toBe('');
    expect(ended?.stderr).toBe(
      `sail dashboard: port ${holder.port} is in use: is another sail dashboard running? --port picks another\n`,
    );
  } finally {
    await holder.stop(true);
  }
}, 15_000);

test('with nothing to stop it, sail dashboard refuses with exit 3 rather than serve forever; an extra argument is refused', async () => {
  const home = sailHome();
  const alone = runCaptured(['dashboard', '--port', '0'], home, { env: { SAIL_HOME: home } });
  const ended = await Promise.race([alone, after<undefined>(5000, undefined)]);
  expect(ended).toEqual({
    code: EXIT_REFUSED as ExitCode,
    stdout: '',
    stderr: 'sail dashboard: nothing can stop it here: run it from a terminal\n',
  });
  const extra = await runCaptured(['dashboard', 'extra'], home, { env: { SAIL_HOME: home } });
  expect([extra.code, extra.stderr]).toEqual([
    EXIT_REFUSED,
    "sail: unknown argument 'extra'\nRun 'sail --help' for usage.\n",
  ]);
}, 15_000);

test('the usage lists sail dashboard', async () => {
  const { stdout } = await runCaptured(['--help']);
  expect(stdout).toMatch(
    /^ {2}sail dashboard \[--port <n>\] {2,}Serve every repository's runs read-only on localhost$/m,
  );
}, 15_000);

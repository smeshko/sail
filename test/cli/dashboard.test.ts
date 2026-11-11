// `sail dashboard [--port N]`, in process through run(): it serves in the foreground until the interrupt, and refuses a
// port it can't take with exit code 3. The registry is a temporary SAIL_HOME's, and every server binds a free port.
import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type DashboardDeps, dashboardCommand, portFree } from '../../src/cli/commands/dashboard';
import { EXIT_OK, EXIT_REFUSED, EXIT_RESTART, type ExitCode } from '../../src/cli/exit-codes';
import { type Io, run } from '../../src/cli/index';
import type { Launchctl } from '../../src/cli/service';
import { fakeTimers } from '../helpers/fake-timers';
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
    /^ {2}sail dashboard \[--port <n>\] {2,}Serve every repository's runs and queues on localhost$/m,
  );
}, 15_000);

// --- the login service ---

/** A dashboard command on a recording launchctl, platform and uid injected, with a HOME of its own. */
function service(platform = 'darwin', portFree: (port: number) => Promise<boolean> = async () => true) {
  const calls: string[][] = [];
  const launchctl: Launchctl = async (args) => {
    calls.push(args);
    return { code: 0, stdout: '', stderr: '' };
  };
  const home = sailHome();
  const machine = sailHome();
  const deps: DashboardDeps = {
    service: { platform, uid: 501, launchctl, home, sail: ['/bin/bun', '/sail/main.ts'] },
    portFree,
  };
  const plist = join(home, 'Library', 'LaunchAgents', 'sail.dashboard.plist');
  const sail = async (values: Record<string, boolean | string>) => {
    let stdout = '';
    let stderr = '';
    const code = await dashboardCommand(deps)(
      { values, positionals: [] },
      {
        cwd: machine,
        env: { SAIL_HOME: machine, HOME: home },
        stdout: (t) => (stdout += t),
        stderr: (t) => (stderr += t),
      },
    );
    return { code, stdout, stderr };
  };
  return { calls, plist, sail, machine };
}

test('sail dashboard --install --port 3411 exits 0, writes sail.dashboard.plist ending dashboard, --service, --port, 3411, and bootstraps it', async () => {
  const s = service();
  const got = await s.sail({ install: true, port: '3411' });
  expect(got.code).toBe(EXIT_OK);
  expect(readFileSync(s.plist, 'utf8')).toContain(
    '<string>/sail/main.ts</string>\n    <string>dashboard</string>\n    <string>--service</string>\n    <string>--port</string>\n    <string>3411</string>\n  </array>',
  );
  expect(readFileSync(s.plist, 'utf8')).toContain(`<key>WorkingDirectory</key>\n  <string>${s.machine}</string>`);
  expect(s.calls).toEqual([
    ['bootout', 'gui/501/sail.dashboard'],
    ['bootstrap', 'gui/501', s.plist],
  ]);
  expect(got.stdout).toContain("installed the login service 'sail.dashboard'");
  expect(got.stdout).toContain('http://127.0.0.1:3411');
});

test('sail dashboard --install with no port installs the default port 3400', async () => {
  const s = service();
  await s.sail({ install: true });
  expect(readFileSync(s.plist, 'utf8')).toContain('<string>--port</string>\n    <string>3400</string>');
});

test("sail dashboard --install --port nope exits 3 with today's port refusal and writes nothing", async () => {
  const s = service();
  const got = await s.sail({ install: true, port: 'nope' });
  expect([got.code, got.stderr]).toEqual([EXIT_REFUSED, 'sail dashboard: --port takes a port number, 0 to 65535\n']);
  expect(existsSync(s.plist)).toBe(false);
  expect(s.calls).toEqual([]);
});

test('sail dashboard --install --port 0 exits 3, since the agent would serve on another port at each start, and writes nothing', async () => {
  const s = service();
  const got = await s.sail({ install: true, port: '0' });
  expect([got.code, got.stderr]).toEqual([
    EXIT_REFUSED,
    'sail dashboard: --install takes a fixed port, 1 to 65535: with 0 the login service would serve on another port at each start\n',
  ]);
  expect(existsSync(s.plist)).toBe(false);
  expect(s.calls).toEqual([]);
});

test('sail dashboard --install on a port in use exits 3 naming it and writes nothing, so the agent does not loop', async () => {
  const holder = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('held') });
  try {
    const s = service('darwin', portFree);
    const got = await s.sail({ install: true, port: String(holder.port) });
    expect([got.code, got.stderr]).toEqual([
      EXIT_REFUSED,
      `sail dashboard: port ${holder.port} is in use: is another sail dashboard running? --port picks another\n`,
    ]);
    expect(existsSync(s.plist)).toBe(false);
    expect(s.calls).toEqual([]);
  } finally {
    await holder.stop(true);
  }
});

test('sail dashboard --restart kickstarts the agent and prints that it restarted; with none installed it exits 3 and launchctl sees nothing', async () => {
  const s = service();
  const none = await s.sail({ restart: true });
  expect([none.code, none.stderr]).toEqual([
    EXIT_REFUSED,
    'sail dashboard: no login service is installed: sail dashboard --install installs it\n',
  ]);
  expect(s.calls).toEqual([]);
  await s.sail({ install: true });
  s.calls.length = 0;
  const got = await s.sail({ restart: true });
  expect([got.code, got.stdout]).toEqual([EXIT_OK, 'sail dashboard: restarted the login service\n']);
  expect(s.calls).toEqual([['kickstart', '-k', 'gui/501/sail.dashboard']]);
});

test('sail dashboard --uninstall boots the agent out and deletes its plist, and refuses with none installed', async () => {
  const s = service();
  expect((await s.sail({ uninstall: true })).code).toBe(EXIT_REFUSED);
  await s.sail({ install: true });
  s.calls.length = 0;
  expect((await s.sail({ uninstall: true })).code).toBe(EXIT_OK);
  expect(s.calls).toEqual([['bootout', 'gui/501/sail.dashboard']]);
  expect(existsSync(s.plist)).toBe(false);
});

test('on linux sail dashboard --install, --uninstall and --restart exit 3 naming macOS and write nothing; two of them exit 3 too', async () => {
  const s = service('linux');
  for (const option of ['install', 'uninstall', 'restart']) {
    const got = await s.sail({ [option]: true });
    expect([got.code, got.stderr]).toEqual([
      EXIT_REFUSED,
      'sail dashboard: a login service is macOS only: launchd is its service manager\n',
    ]);
  }
  expect(existsSync(s.plist)).toBe(false);
  const two = await s.sail({ install: true, restart: true });
  expect(two.stderr).toBe('sail dashboard: take one of --install, --uninstall and --restart\n');
});

test('a dashboard serving under --service returns 6 once its version changes and frees its port; one without --service keeps serving', async () => {
  for (const serviceMode of [true, false]) {
    const home = sailHome();
    let stdout = '';
    const interrupts = fakeInterrupts();
    const timers = fakeTimers('2026-10-15T09:00:00.000Z');
    const version = { current: 'aaaaaaa1' };
    const running = dashboardCommand({ timers, sailVersion: () => version.current, sailVersionEveryMs: 60_000 })(
      { values: serviceMode ? { port: '0', service: true } : { port: '0' }, positionals: [] },
      {
        cwd: home,
        env: { SAIL_HOME: home },
        stdout: (t) => (stdout += t),
        stderr: () => {},
        onInterrupt: interrupts.onInterrupt as NonNullable<Io['onInterrupt']>,
      },
    );
    const deadline = Date.now() + 5000;
    while (!stdout.includes('Ctrl-C stops it\n') && Date.now() < deadline) await Bun.sleep(10);
    const port = Number(/127\.0\.0\.1:(\d+)/.exec(stdout)?.[1]);
    await Bun.sleep(0);
    version.current = 'bbbbbbb2';
    await timers.advance(60_000);
    if (serviceMode) {
      expect(await Promise.race([running, after(5000, 'still running')])).toBe(EXIT_RESTART);
      expect(stdout).toContain('sail dashboard: sail changed (aaaaaaa → bbbbbbb)');
      expect(await listening(port)).toBe(false);
    } else {
      expect(await Promise.race([running, after(300, 'still running')])).toBe('still running');
      expect(await listening(port)).toBe(true);
      interrupts.interrupt();
      expect(await running).toBe(EXIT_OK);
    }
  }
}, 20_000);

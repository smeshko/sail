// The launchd agent a login service is installed as: its plist, and install, uninstall and restart through launchctl.
// Every case injects the platform and a recording launchctl, so none reaches the machine's own launchd.
import { afterEach, expect, test } from 'bun:test';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DASHBOARD_LABEL,
  installAgent,
  installedWatchers,
  type Launchctl,
  logPath,
  platformRefusal,
  plistPath,
  renderPlist,
  restartAgent,
  type ServiceDeps,
  systemLaunchctl,
  uninstallAgent,
  watcherLabel,
} from '../../src/cli/service';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function temp(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'sail-service-')));
  dirs.push(dir);
  return dir;
}

type Reply = { code: number; stdout?: string; stderr?: string };
function recording(reply: (args: string[]) => Reply = () => ({ code: 0 })) {
  const calls: string[][] = [];
  const launchctl: Launchctl = async (args) => {
    calls.push(args);
    const got = reply(args);
    return { code: got.code, stdout: got.stdout ?? '', stderr: got.stderr ?? '' };
  };
  return { calls, launchctl };
}
function depsOf(launchctl: Launchctl, home: string, platform = 'darwin'): ServiceDeps {
  return { platform, uid: 501, launchctl, home, sail: ['/bin/bun', '--no-env-file', '/sail/src/cli/main.ts'] };
}
const spec = (dir: string) => ({
  label: watcherLabel('demo'),
  args: ['watch', '--service', 'a'],
  workingDirectory: join(dir, 'clone'),
  environment: { PATH: '/bin:/usr/bin' } as Record<string, string>,
  log: join(dir, 'machine', 'services', 'sail.watcher.demo.log'),
});

test('the plist of a watcher holds its label, arguments, working directory, keep-alive terms, logs and exactly PATH and SAIL_HOME', () => {
  const text = renderPlist({
    label: 'sail.watcher.demo',
    programArguments: ['/bin/bun', '--no-env-file', '/sail/main.ts', 'watch', '--service', 'a'],
    workingDirectory: '/work/clone',
    environment: { PATH: '/bin', SAIL_HOME: '/home/.sail' },
    log: '/home/.sail/services/sail.watcher.demo.log',
  });
  expect(text).toContain('<key>Label</key>\n  <string>sail.watcher.demo</string>');
  expect(text).toContain(
    '<array>\n    <string>/bin/bun</string>\n    <string>--no-env-file</string>\n    <string>/sail/main.ts</string>\n    <string>watch</string>\n    <string>--service</string>\n    <string>a</string>\n  </array>',
  );
  expect(text).toContain('<key>WorkingDirectory</key>\n  <string>/work/clone</string>');
  expect(text).toContain('<key>RunAtLoad</key>\n  <true/>');
  expect(text).toContain('<key>KeepAlive</key>\n  <dict>\n    <key>SuccessfulExit</key>\n    <false/>\n  </dict>');
  expect(text).toContain('<key>ThrottleInterval</key>\n  <integer>60</integer>');
  expect(text).toContain('<key>AbandonProcessGroup</key>\n  <true/>');
  expect(text).toContain('<key>StandardOutPath</key>\n  <string>/home/.sail/services/sail.watcher.demo.log</string>');
  expect(text).toContain('<key>StandardErrorPath</key>\n  <string>/home/.sail/services/sail.watcher.demo.log</string>');
  expect(text).toContain(
    '<key>EnvironmentVariables</key>\n  <dict>\n    <key>PATH</key>\n    <string>/bin</string>\n    <key>SAIL_HOME</key>\n    <string>/home/.sail</string>\n  </dict>',
  );
});

test('a path holding &, < and > is escaped in the plist', () => {
  const text = renderPlist({
    label: 'sail.dashboard',
    programArguments: ['/a&b/<c>'],
    workingDirectory: '/x',
    environment: { PATH: '/p' },
    log: '/l',
  });
  expect(text).toContain('<string>/a&amp;b/&lt;c&gt;</string>');
  expect(text).not.toContain('/a&b/');
});

test('paths and labels: the plist under HOME, the log under the machine directory', () => {
  expect(watcherLabel('demo')).toBe('sail.watcher.demo');
  expect(DASHBOARD_LABEL).toBe('sail.dashboard');
  expect(plistPath('/h', 'sail.dashboard')).toBe('/h/Library/LaunchAgents/sail.dashboard.plist');
  expect(logPath('/m', 'sail.dashboard')).toBe('/m/services/sail.dashboard.log');
});

test('installAgent boots out, writes the plist and its log folder, then bootstraps; a failing bootout does not fail it', async () => {
  const dir = temp();
  const { calls, launchctl } = recording((args) =>
    args[0] === 'bootout' ? { code: 113, stderr: 'not loaded' } : { code: 0 },
  );
  const result = await installAgent(depsOf(launchctl, dir), spec(dir));
  const plist = plistPath(dir, 'sail.watcher.demo');
  expect(result).toEqual({ plist, log: spec(dir).log });
  expect(calls).toEqual([
    ['bootout', 'gui/501/sail.watcher.demo'],
    ['bootstrap', 'gui/501', plist],
  ]);
  const text = readFileSync(plist, 'utf8');
  expect(text).toContain('<string>/bin/bun</string>');
  expect(text).toContain('<string>--service</string>');
  expect(existsSync(join(dir, 'machine', 'services'))).toBe(true);
});

test('a failing bootstrap is a refusal quoting launchctl stderr', async () => {
  const dir = temp();
  const { launchctl } = recording((args) =>
    args[0] === 'bootstrap' ? { code: 5, stderr: 'Bootstrap failed: 5' } : { code: 0 },
  );
  const result = await installAgent(depsOf(launchctl, dir), spec(dir));
  expect(result).toEqual({ refused: 'launchctl bootstrap failed (exit 5): Bootstrap failed: 5' });
});

test('restartAgent kickstarts with -k, and uninstallAgent boots out and deletes the plist', async () => {
  const dir = temp();
  const rec = recording();
  const deps = depsOf(rec.launchctl, dir);
  await installAgent(deps, spec(dir));
  rec.calls.length = 0;
  expect(await restartAgent(deps, 'sail.watcher.demo', 'none')).toEqual({});
  expect(rec.calls).toEqual([['kickstart', '-k', 'gui/501/sail.watcher.demo']]);
  rec.calls.length = 0;
  expect(await uninstallAgent(deps, 'sail.watcher.demo', 'none')).toEqual({});
  expect(rec.calls).toEqual([['bootout', 'gui/501/sail.watcher.demo']]);
  expect(existsSync(plistPath(dir, 'sail.watcher.demo'))).toBe(false);
});

test('a failing kickstart is a refusal quoting launchctl stderr', async () => {
  const dir = temp();
  const rec = recording((args) => (args[0] === 'kickstart' ? { code: 3, stderr: 'no such service' } : { code: 0 }));
  const deps = depsOf(rec.launchctl, dir);
  await installAgent(deps, spec(dir));
  expect(await restartAgent(deps, 'sail.watcher.demo', 'none')).toEqual({
    refused: 'launchctl kickstart failed (exit 3): no such service',
  });
});

test('with no plist, restart and uninstall return the not-installed refusal and launchctl sees no call', async () => {
  const dir = temp();
  const rec = recording();
  const deps = depsOf(rec.launchctl, dir);
  expect(await restartAgent(deps, 'sail.watcher.demo', 'nothing installed')).toEqual({ refused: 'nothing installed' });
  expect(await uninstallAgent(deps, 'sail.watcher.demo', 'nothing installed')).toEqual({
    refused: 'nothing installed',
  });
  expect(rec.calls).toEqual([]);
});

test('the platform check refuses off macOS naming it, and passes on darwin', () => {
  expect(platformRefusal('linux')).toBe('a login service is macOS only: launchd is its service manager');
  expect(platformRefusal('darwin')).toBeUndefined();
});

test('installedWatchers lists the repository names of the watcher plists, sorted, and not the dashboard', async () => {
  const dir = temp();
  const deps = depsOf(recording().launchctl, dir);
  expect(installedWatchers(dir)).toEqual([]);
  for (const label of ['sail.watcher.zeta', 'sail.watcher.alpha', DASHBOARD_LABEL]) {
    await installAgent(deps, { ...spec(dir), label });
  }
  expect(installedWatchers(dir)).toEqual(['alpha', 'zeta']);
});

test('the system runner returns the exit code, stdout and stderr of the launchctl it finds on the PATH', async () => {
  const dir = temp();
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'launchctl'), '#!/bin/sh\necho "out:$*"\necho "err" >&2\nexit 7\n');
  chmodSync(join(bin, 'launchctl'), 0o755);
  const result = await systemLaunchctl({ PATH: bin })(['kickstart', '-k', 'x']);
  expect(result).toEqual({ code: 7, stdout: 'out:kickstart -k x\n', stderr: 'err\n' });
});

test('the system runner reports a launchctl that is not on the PATH as exit 127', async () => {
  const result = await systemLaunchctl({ PATH: temp() })(['print']);
  expect(result.code).toBe(127);
  expect(result.stderr).toContain('launchctl');
});

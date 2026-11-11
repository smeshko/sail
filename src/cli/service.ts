// A login service: a watcher or the dashboard installed as a launchd agent in the user's login session (macOS only).
// This module knows the agent's label, its plist and its log, and drives `launchctl` to load, unload and restart it;
// the commands decide what to install. A test injects the platform and the `launchctl` runner, so none reaches the
// machine's own launchd.
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { PACKAGE_ROOT } from '../engine/typecheck';

export const DASHBOARD_LABEL = 'sail.dashboard';
const WATCHER_PREFIX = 'sail.watcher.';

/** The label of the agent of the repository `name`. */
export const watcherLabel = (name: string): string => `${WATCHER_PREFIX}${name}`;

/** Where the agent `label`'s plist lives: under the user's `~/Library/LaunchAgents`, which launchd reads at login. */
export function plistPath(home: string, label: string): string {
  return join(home, 'Library', 'LaunchAgents', `${label}.plist`);
}

/** Where the agent `label`'s output goes: `services/` in the machine directory. */
export function logPath(machine: string, label: string): string {
  return join(machine, 'services', `${label}.log`);
}

export interface PlistSpec {
  label: string;
  programArguments: readonly string[];
  workingDirectory: string;
  environment: Readonly<Record<string, string>>;
  log: string;
}

const escapeXml = (text: string): string =>
  text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
const str = (text: string, indent: string): string => `${indent}<string>${escapeXml(text)}</string>`;

/**
 * The plist text. It restarts the service after any exit but 0 (a person's stop or an emptied watch set stays down),
 * at most once a minute, and leaves the processes the service started alone when it ends.
 */
export function renderPlist(spec: PlistSpec): string {
  const environment = Object.entries(spec.environment)
    .flatMap(([key, value]) => [`    <key>${escapeXml(key)}</key>`, str(value, '    ')])
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
${str(spec.label, '  ')}
  <key>ProgramArguments</key>
  <array>
${spec.programArguments.map((each) => str(each, '    ')).join('\n')}
  </array>
  <key>WorkingDirectory</key>
${str(spec.workingDirectory, '  ')}
  <key>EnvironmentVariables</key>
  <dict>
${environment}
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>ThrottleInterval</key>
  <integer>60</integer>
  <key>AbandonProcessGroup</key>
  <true/>
  <key>StandardOutPath</key>
${str(spec.log, '  ')}
  <key>StandardErrorPath</key>
${str(spec.log, '  ')}
</dict>
</plist>
`;
}

export interface LaunchctlResult {
  code: number;
  stdout: string;
  stderr: string;
}
/** Runs `launchctl` with these arguments. */
export type Launchctl = (args: string[]) => Promise<LaunchctlResult>;

/** The `launchctl` found on `env`'s PATH. A machine with none answers exit 127. */
export function systemLaunchctl(env: Readonly<Record<string, string | undefined>>): Launchctl {
  return async (args) => {
    const program = Bun.which('launchctl', env.PATH === undefined ? {} : { PATH: env.PATH });
    if (program === null) return { code: 127, stdout: '', stderr: 'launchctl is not on the PATH' };
    const child = Bun.spawn([program, ...args], { stdout: 'pipe', stderr: 'pipe', stdin: 'ignore' });
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return { code, stdout, stderr };
  };
}

export interface ServiceDeps {
  platform: string;
  uid: number;
  launchctl: Launchctl;
  /** The user's home: the plist goes under its `Library/LaunchAgents`. */
  home: string;
  /** The command that starts this sail: the Bun, `--no-env-file` and the path of the bin. */
  sail: readonly string[];
}

/** Why a login service can't be made here: it is launchd's. Undefined on macOS. */
export function platformRefusal(platform: string): string | undefined {
  return platform === 'darwin' ? undefined : 'a login service is macOS only: launchd is its service manager';
}

export interface AgentSpec {
  label: string;
  /** What follows the sail command: `watch --service …` or `dashboard --service …`. */
  args: readonly string[];
  workingDirectory: string;
  environment: Readonly<Record<string, string>>;
  log: string;
}

export type Refused = { refused: string };
/** What an operation that succeeded returns: no refusal. */
export type Done = { refused?: undefined };

const target = (deps: ServiceDeps, label: string) => `gui/${deps.uid}/${label}`;
const failed = (verb: string, result: LaunchctlResult): Refused => ({
  refused: `launchctl ${verb} failed (exit ${result.code}): ${result.stderr.trim()}`,
});

/** Replaces the agent: boots out the old one (a failure is no matter), writes the plist, and bootstraps it. */
export async function installAgent(
  deps: ServiceDeps,
  spec: AgentSpec,
): Promise<{ plist: string; log: string } | Refused> {
  const plist = plistPath(deps.home, spec.label);
  await deps.launchctl(['bootout', target(deps, spec.label)]);
  mkdirSync(dirname(plist), { recursive: true });
  mkdirSync(dirname(spec.log), { recursive: true });
  writeFileSync(
    plist,
    renderPlist({
      label: spec.label,
      programArguments: [...deps.sail, ...spec.args],
      workingDirectory: spec.workingDirectory,
      environment: spec.environment,
      log: spec.log,
    }),
  );
  const result = await deps.launchctl(['bootstrap', `gui/${deps.uid}`, plist]);
  return result.code === 0 ? { plist, log: spec.log } : failed('bootstrap', result);
}

/** Boots the agent out and deletes its plist; `notInstalled` is the refusal when there is no plist. */
export async function uninstallAgent(deps: ServiceDeps, label: string, notInstalled: string): Promise<Refused | Done> {
  const plist = plistPath(deps.home, label);
  if (!existsSync(plist)) return { refused: notInstalled };
  await deps.launchctl(['bootout', target(deps, label)]);
  rmSync(plist, { force: true });
  return {};
}

/** Kills the agent's process and starts it again; `notInstalled` is the refusal when there is no plist. */
export async function restartAgent(deps: ServiceDeps, label: string, notInstalled: string): Promise<Refused | Done> {
  if (!existsSync(plistPath(deps.home, label))) return { refused: notInstalled };
  const result = await deps.launchctl(['kickstart', '-k', target(deps, label)]);
  return result.code === 0 ? {} : failed('kickstart', result);
}

/** The repository names of the installed watcher agents, sorted, read from the plist files. */
export function installedWatchers(home: string): string[] {
  let files: string[];
  try {
    files = readdirSync(dirname(plistPath(home, 'x')));
  } catch {
    return [];
  }
  return files
    .filter((file) => file.startsWith(WATCHER_PREFIX) && file.endsWith('.plist'))
    .map((file) => file.slice(WATCHER_PREFIX.length, -'.plist'.length))
    .sort();
}

/** The system's deps for a command run in `env`, with `overrides` for what a test injects. */
export function serviceDeps(
  env: Readonly<Record<string, string | undefined>>,
  overrides: Partial<ServiceDeps> = {},
): ServiceDeps {
  return {
    platform: overrides.platform ?? process.platform,
    uid: overrides.uid ?? process.getuid?.() ?? 0,
    launchctl: overrides.launchctl ?? systemLaunchctl(env),
    home: overrides.home ?? env.HOME ?? homedir(),
    sail: overrides.sail ?? [process.execPath, '--no-env-file', join(PACKAGE_ROOT, 'src', 'cli', 'main.ts')],
  };
}

/** The environment an agent runs with: a `PATH` that finds this Bun and the installing shell's tools, and `SAIL_HOME`. */
export function agentEnvironment(env: Readonly<Record<string, string | undefined>>): Record<string, string> {
  const path = [dirname(process.execPath), ...(env.PATH === undefined || env.PATH === '' ? [] : [env.PATH])].join(':');
  return { PATH: path, ...(env.SAIL_HOME === undefined || env.SAIL_HOME === '' ? {} : { SAIL_HOME: env.SAIL_HOME }) };
}

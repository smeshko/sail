// `sail dashboard [--port N]`: serves every registered repository's runs and queues on 127.0.0.1, in the foreground,
// until Ctrl-C. `--install [--port N]`, `--uninstall` and `--restart` run it as a login service instead (macOS only,
// one machine-wide launchd agent, `sail.dashboard`): at most one of the three, the platform checked before anything is
// written, and a refusal (exit code 3) when there is nothing to uninstall or restart, or the port is no port. `--install`
// also refuses port 0 and, while no agent is installed, a port another process holds. A
// restart prints `sail dashboard: restarted the login service`: the dashboard records no pid anywhere. `--service`,
// which only the installed agent passes, also reads sail's code version at start and every minute and, once it
// changes in `src/`, `package.json` or `bun.lock`, prints a line starting `sail dashboard: sail changed (`, stops the server and exits 6, so launchd starts the
// new code. It writes nothing but a move command in a live watcher's inbox, when a person moves a queued item, a
// release of a usage-limit hold in the machine directory, and the runs a person resumes or restarts, which it starts detached with this command's environment. The default port is
// 3400, and 0 picks a free one. A port that isn't a whole number from 0 to 65535, or one in use, is refused with exit
// code 3.

import { existsSync } from 'node:fs';
import { createServer } from 'node:net';
import { startDashboard } from '../../dashboard/server';
import { systemTimers, type Timers } from '../../watch/poll';
import { machineDir, registryDir as registryDirOf } from '../../watch/registry';
import { EXIT_OK, EXIT_RESTART, type ExitCode } from '../exit-codes';
import type { Io, Parsed } from '../index';
import { type CodeChanged, type ReadVersion, sailCodeChanged, sailVersion, watchSailChange } from '../sail-change';
import {
  agentEnvironment,
  DASHBOARD_LABEL,
  installAgent,
  logPath,
  platformRefusal,
  plistPath,
  restartAgent,
  type ServiceDeps,
  serviceDeps,
  uninstallAgent,
} from '../service';
import { refuseAs } from './run-workflow';

const COMMAND = 'sail dashboard';
export const DEFAULT_PORT = 3400;

/** The port `--port` names: a whole number from 0 to 65535, or undefined. */
function portOf(value: string): number | undefined {
  if (!/^[0-9]+$/.test(value)) return undefined;
  const port = Number(value);
  return port <= 65535 ? port : undefined;
}

/** Whether nothing serves on 127.0.0.1:`port` now: it binds the port and lets it go. */
export function portFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once('error', () => resolve(false));
    server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)));
  });
}

/** What the command runs on: the system's unless a test hands its own. */
export interface DashboardDeps {
  service?: Partial<ServiceDeps>;
  /** Reads sail's code version, for a dashboard started with `--service`: its checkout's `HEAD` by default. */
  sailVersion?: ReadVersion;
  /** How often it reads it: 60 000 ms by default. */
  sailVersionEveryMs?: number;
  /** Whether two code versions differ in sail's code: `sailCodeChanged` on its checkout by default. */
  sailChanged?: CodeChanged;
  timers?: Timers;
  /** Whether `--install`'s port is free: `portFree` by default. */
  portFree?: (port: number) => Promise<boolean>;
}

const NOT_INSTALLED = `no login service is installed: ${COMMAND} --install installs it`;

export function dashboardCommand(deps: DashboardDeps = {}) {
  return async (args: Parsed, io: Io): Promise<ExitCode> => {
    const refuse = refuseAs(io, COMMAND);
    const env = io.env ?? process.env;
    const wanted = (['install', 'uninstall', 'restart'] as const).filter((option) => args.values[option] === true);
    if (wanted.length > 1) return refuse('take one of --install, --uninstall and --restart');
    const given = args.values.port;
    const port = typeof given === 'string' ? portOf(given) : DEFAULT_PORT;
    const operation = wanted[0];
    if (operation !== undefined) {
      const service = serviceDeps(env, deps.service);
      const platform = platformRefusal(service.platform);
      if (platform !== undefined) return refuse(platform);
      if (operation === 'install') {
        if (port === undefined) return refuse('--port takes a port number, 0 to 65535');
        if (port === 0) {
          return refuse(
            '--install takes a fixed port, 1 to 65535: with 0 the login service would serve on another port at each start',
          );
        }
        // A port another process holds would refuse the agent's every start, once a minute: the install refuses it
        // first. An installed agent's own dashboard may hold it, and is replaced.
        if (!existsSync(plistPath(service.home, DASHBOARD_LABEL)) && !(await (deps.portFree ?? portFree)(port))) {
          return refuse(`port ${port} is in use: is another sail dashboard running? --port picks another`);
        }
        const machine = machineDir(env);
        const result = await installAgent(service, {
          label: DASHBOARD_LABEL,
          args: ['dashboard', '--service', '--port', String(port)],
          workingDirectory: machine,
          environment: agentEnvironment(env),
          log: logPath(machine, DASHBOARD_LABEL),
        });
        if ('refused' in result) return refuse(result.refused);
        io.stdout(
          `${COMMAND}: installed the login service '${DASHBOARD_LABEL}' (${result.plist}); its log is ${result.log}; it serves http://127.0.0.1:${port}\n`,
        );
        return EXIT_OK;
      }
      const result =
        operation === 'uninstall'
          ? await uninstallAgent(service, DASHBOARD_LABEL, NOT_INSTALLED)
          : await restartAgent(service, DASHBOARD_LABEL, NOT_INSTALLED);
      if (result.refused !== undefined) return refuse(result.refused);
      io.stdout(
        operation === 'uninstall'
          ? `${COMMAND}: uninstalled the login service '${DASHBOARD_LABEL}'\n`
          : `${COMMAND}: restarted the login service\n`,
      );
      return EXIT_OK;
    }
    if (port === undefined) return refuse('--port takes a port number, 0 to 65535');
    const onInterrupt = io.onInterrupt;
    if (onInterrupt === undefined) return refuse('nothing can stop it here: run it from a terminal');
    const registryDir = registryDirOf(machineDir(env));
    const started = startDashboard({ registryDir, machineDir: machineDir(env), port, env });
    if ('refused' in started) {
      return refuse(`${started.refused}: is another sail dashboard running? --port picks another`);
    }
    io.stdout(
      `${COMMAND}: http://127.0.0.1:${started.port}\nreading the registry in ${registryDir}; Ctrl-C stops it\n`,
    );
    let changed = false;
    let stopChange: (() => void) | undefined;
    await new Promise<void>((resolve) => {
      const unregister = onInterrupt(() => {
        unregister();
        resolve();
      });
      if (args.values.service === true) {
        stopChange = watchSailChange({
          read: deps.sailVersion ?? sailVersion,
          everyMs: deps.sailVersionEveryMs ?? 60_000,
          timers: deps.timers ?? systemTimers,
          changed: deps.sailChanged ?? ((before, after) => sailCodeChanged(before, after)),
          onChange(before, after) {
            changed = true;
            io.stdout(
              `${COMMAND}: sail changed (${before.slice(0, 7)} → ${after.slice(0, 7)}): stopping, so the login service starts the new code\n`,
            );
            unregister();
            resolve();
          },
        });
      }
    });
    stopChange?.();
    await started.stop();
    return changed ? EXIT_RESTART : EXIT_OK;
  };
}

export const dashboard = dashboardCommand();

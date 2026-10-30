// `sail dashboard [--port N]`: serves every registered repository's runs and queues on 127.0.0.1, in the foreground,
// until Ctrl-C. It writes nothing but a move command in a live watcher's inbox, when a person moves a queued item, and
// the runs a person resumes or restarts, which it starts detached with this command's environment. The default port is
// 3400, and 0 picks a free one. A port that isn't a whole number from 0 to 65535, or one in use, is refused with exit
// code 3.

import { startDashboard } from '../../dashboard/server';
import { machineDir, registryDir as registryDirOf } from '../../watch/registry';
import { EXIT_OK, type ExitCode } from '../exit-codes';
import type { Io, Parsed } from '../index';
import { refuseAs } from './run-workflow';

const COMMAND = 'sail dashboard';
export const DEFAULT_PORT = 3400;

/** The port `--port` names: a whole number from 0 to 65535, or undefined. */
function portOf(value: string): number | undefined {
  if (!/^[0-9]+$/.test(value)) return undefined;
  const port = Number(value);
  return port <= 65535 ? port : undefined;
}

export async function dashboard(args: Parsed, io: Io): Promise<ExitCode> {
  const refuse = refuseAs(io, COMMAND);
  const given = args.values.port;
  const port = typeof given === 'string' ? portOf(given) : DEFAULT_PORT;
  if (port === undefined) return refuse('--port takes a port number, 0 to 65535');
  const onInterrupt = io.onInterrupt;
  if (onInterrupt === undefined) return refuse('nothing can stop it here: run it from a terminal');
  const registryDir = registryDirOf(machineDir(io.env ?? process.env));
  const started = startDashboard({ registryDir, port, env: io.env ?? process.env });
  if ('refused' in started) {
    return refuse(`${started.refused}: is another sail dashboard running? --port picks another`);
  }
  io.stdout(`${COMMAND}: http://127.0.0.1:${started.port}\nreading the registry in ${registryDir}; Ctrl-C stops it\n`);
  await new Promise<void>((resolve) => {
    const unregister = onInterrupt(() => {
      unregister();
      resolve();
    });
  });
  await started.stop();
  return EXIT_OK;
}

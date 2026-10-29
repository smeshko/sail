// sail's machine directory holds watchers/, leases/ and slots/.
import { homedir } from 'node:os';
import { join } from 'node:path';

/** sail's machine-level directory: `SAIL_HOME` when it is set and not empty, else `~/.sail`. */
export function machineDir(env: Readonly<Record<string, string | undefined>>): string {
  const home = env.SAIL_HOME;
  return home === undefined || home === '' ? join(homedir(), '.sail') : home;
}

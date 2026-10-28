// sail's own `.sail/` in a temporary repository, every port on its fake, so `sail FAKE-2 --workflow groom` runs the
// committed groom workflow end to end.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Ticket } from '../../src/ports/types';
/** The ticket as the fake holds it after a run: its state file, or the seed while nothing has changed it. */
export function fakeTicket(repoDir: string, ticketKey: string): Ticket {
  const state = join(repoDir, '.sail-runs', 'fake', 'tickets.json');
  const path = existsSync(state) ? state : join(repoDir, '.sail', 'fake', 'tickets.json');
  const world = JSON.parse(readFileSync(path, 'utf8')) as { tickets: Ticket[] };
  const found = world.tickets.find((ticket) => ticket.ticketKey === ticketKey);
  if (found === undefined) throw new Error(`no ticket ${ticketKey} in ${path}`);
  return found;
}

/** The directory of the repository's only run. */
export function onlyRun(repoDir: string): string {
  const runs = join(repoDir, '.sail-runs');
  const ids = readdirSync(runs).filter((name) => name !== 'fake' && name !== 'queue' && name !== 'watcher');
  if (ids.length !== 1) throw new Error(`expected one run in ${runs}, found ${ids.join(', ')}`);
  return join(runs, ids[0] as string);
}

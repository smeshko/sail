// sail's own `.sail/` in a temporary repository, every port on its fake, so `sail FAKE-2 --workflow groom` runs the
// committed groom workflow end to end.
import { cpSync, existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Ticket } from '../../src/ports/types';
import type { TempRepo } from './temp-repo';

const OWN_SAIL = join(import.meta.dir, '..', '..', '.sail');

const FAKE_ADAPTERS = [
  'adapters:',
  '  ticketSource: { use: fake, seed: ./fake/tickets.json }',
  '  codeHost: { use: fake, seed: ./fake/prs.json }',
  '  harness: { use: fake }',
  '  workspace: { use: fake }',
  '',
].join('\n');

/** Copies the repository's own `.sail/` into `repo`, points its ports at the fakes, commits, and returns the copy. */
export function writeGroomRepo(repo: TempRepo): string {
  const sail = join(repo.dir, '.sail');
  cpSync(OWN_SAIL, sail, {
    recursive: true,
    filter: (source) => !source.endsWith('sail.d.ts') && !source.endsWith('sail-intakes.d.ts'),
  });
  const config = join(sail, 'project.yaml');
  const text = readFileSync(config, 'utf8');
  const start = text.indexOf('adapters:\n');
  const end = text.indexOf('\nmodels:');
  writeFileSync(config, `${text.slice(0, start)}${FAKE_ADAPTERS}${text.slice(end)}`);
  // The conventions the config lists are appended to every agent prompt, so they must exist.
  for (const name of ['AGENTS.md', 'CONTEXT.md']) writeFileSync(join(repo.dir, name), `# ${name}\n`);
  repo.git('add', '.sail', 'AGENTS.md', 'CONTEXT.md');
  repo.git('commit', '-m', 'add sail');
  return sail;
}

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

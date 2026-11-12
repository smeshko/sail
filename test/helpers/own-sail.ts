// sail's own `.sail/` in a temporary repository, every port on its fake, so `sail FAKE-1` and `sail '#7' --workflow
// review` run the committed workflows end to end. A Jev seed adds the fake Jev, which a repository leaves out until it
// has one to ask.
import { cpSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { TempRepo } from './temp-repo';

export const OWN_SAIL = join(import.meta.dir, '..', '..', '.sail');

const FAKE_ADAPTERS = [
  'adapters:',
  '  ticketSource: { use: fake, seed: ./fake/tickets.json }',
  '  codeHost: { use: fake, seed: ./fake/prs.json }',
  '  harness: { use: fake }',
  '  workspace: { use: fake }',
  '',
].join('\n');

/** The Jev seed for `answers`, each a noul: its probability of yes by question name. */
export function nouls(answers: Readonly<Record<string, number>>): object {
  return {
    answers: Object.fromEntries(Object.entries(answers).map(([name, noul]) => [name, { type: 'noul', noul }])),
  };
}

/**
 * Copies the repository's own `.sail/` into `repo`, points its ports at the fakes, commits, and returns the copy. With a
 * `jev` seed the copy has a fake Jev answering from it; without, it has none. `conventions` gives the text of `AGENTS.md`
 * or `CONTEXT.md` in place of its one-line stub.
 */
export function writeOwnSail(
  repo: TempRepo,
  options: { jev?: object; conventions?: Readonly<Record<string, string>> } = {},
): string {
  const sail = join(repo.dir, '.sail');
  cpSync(OWN_SAIL, sail, {
    recursive: true,
    filter: (source) => !source.endsWith('sail.d.ts') && !source.endsWith('sail-intakes.d.ts'),
  });
  const config = join(sail, 'project.yaml');
  const text = readFileSync(config, 'utf8');
  const start = text.indexOf('adapters:\n');
  const end = text.indexOf('\nmodels:');
  const jev = options.jev === undefined ? '' : '  jev: { use: fake, seed: ./fake/jev.json }\n';
  writeFileSync(config, `${text.slice(0, start)}${FAKE_ADAPTERS}${jev}${text.slice(end)}`);
  if (options.jev !== undefined) writeFileSync(join(sail, 'fake', 'jev.json'), JSON.stringify(options.jev));
  // The config's default and the stages' own lists name these two files, so both must exist.
  for (const name of ['AGENTS.md', 'CONTEXT.md'])
    writeFileSync(join(repo.dir, name), options.conventions?.[name] ?? `# ${name}\n`);
  repo.git('add', '.sail', 'AGENTS.md', 'CONTEXT.md');
  repo.git('commit', '-m', 'add sail');
  return sail;
}

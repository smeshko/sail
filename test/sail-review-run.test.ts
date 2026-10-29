// sail's own `review` workflow, end to end through the CLI on the fakes: `sail '#7' --workflow review` in a temporary
// repository that holds a copy of the repository's own `.sail/`, its ports all fake and, where a case seeds one, a fake
// Jev. The cases are about check-fix: Jev's clear yes on every targeted finding ends a fix round without an agent
// session, anything else leaves it to the agent, with Jev's answers as its hint. One case is about the tickets it files.
import { expect, test } from 'bun:test';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readJournal } from '../src/engine/journal';
import { readEvents } from '../src/events/consumers/ndjson';
import type { Summary } from '../src/events/summary';
import { seedHarness } from './helpers/fixture';
import { onlyRun } from './helpers/groom-fixture';
import { nouls, writeOwnSail } from './helpers/own-sail';
import { runCaptured } from './helpers/run-captured';
import { type TempRepo, withTempRepo } from './helpers/temp-repo';

const RUN = ['#7', '--workflow', 'review'];
const TARGETS = ['V1', 'D1', 'R2'];

/** Jev's seed: every targeted finding at `0.99` but those `overrides` names. */
const seed = (overrides: Record<string, number> = {}) =>
  nouls(Object.fromEntries(TARGETS.map((id) => [id, overrides[id] ?? 0.99])));

/** The repository's own `.sail/` on fakes, with fake pull request #7 pointed at commits the repository holds. */
function setUp(repo: TempRepo, jev?: object): void {
  writeOwnSail(repo, jev === undefined ? {} : { jev });
  const base = repo.git('rev-parse', 'HEAD').trim();
  writeFileSync(join(repo.dir, 'notes.txt'), 'a change\n');
  repo.git('add', 'notes.txt');
  repo.git('commit', '-m', 'the pull request');
  const head = repo.git('rev-parse', 'HEAD').trim();
  const prs = join(repo.dir, '.sail', 'fake', 'prs.json');
  writeFileSync(
    prs,
    readFileSync(prs, 'utf8')
      .replaceAll('cb9c6b50425ad5072892f561cc7459be4c65983d', head)
      .replaceAll('8cdaad7c30e274ed1e7ae6dfd185d6bd14087447', base),
  );
}

/** `sail '#7' --workflow review` in `repo`: its exit code and stderr, the keys its journal holds and its run directory. */
async function review(repo: TempRepo): Promise<{ code: number; stderr: string; keys: string[]; dir: string }> {
  const { code, stderr } = await runCaptured(RUN, repo.dir, { env: repo.env });
  let dir: string;
  try {
    dir = onlyRun(repo.dir);
  } catch (error) {
    throw new Error(`${error}\nexit ${code}\n${stderr}`);
  }
  return { code, stderr, keys: readJournal(dir).entries.map((entry) => entry.key), dir };
}

/** The `$STAGE_IN/jev.json` of a call, parsed. */
function jevHint(dir: string, stage: string, call: number): { asked: boolean; answers: { id: string; yes: number }[] } {
  const folder = readdirSync(dir).find((name) => name.replace(/^\d+-/, '') === stage);
  if (folder === undefined) throw new Error(`no ${stage} folder in ${dir}`);
  return JSON.parse(readFileSync(join(dir, folder, `call-${call}`, 'in', 'jev.json'), 'utf8'));
}

const asked = (dir: string, key: string) =>
  readEvents(dir).filter((event) => event.type === 'jev:asked' && (event as { key?: string }).key === key);

test('with Jev answering every targeted finding a clear yes, jev-fix#1 runs, check-fix never does, and the fix loop ends after one round', async () => {
  await withTempRepo(async (repo) => {
    setUp(repo, seed());
    const { code, stderr, keys, dir } = await review(repo);
    expect({ code, stderr }).toEqual({ code: 0, stderr: '' });

    expect(keys.filter((key) => key.startsWith('check-fix#'))).toEqual([]);
    expect(keys.filter((key) => key.startsWith('fix#'))).toEqual(['fix#1']);
    const at = keys.indexOf('jev-fix#1');
    expect(keys.slice(at - 1, at + 3)).toEqual(['fix#1', 'jev-fix#1', 'validate#2', 'push#1']);
    expect(asked(dir, 'jev-fix#1')).toHaveLength(1);
    const summary = JSON.parse(readFileSync(join(dir, 'summary.json'), 'utf8')) as Summary;
    expect(summary.loops?.fix?.iterations).toBe(1);
  });
}, 120_000);

test.each([
  ['unclear', 0.6],
  ['a no', 0.05],
])(
  'with Jev answering R2 %s, check-fix#1 runs after jev-fix#1 with the answers as its hint',
  async (_name, yes) => {
    await withTempRepo(async (repo) => {
      setUp(repo, seed({ R2: yes }));
      const { code, stderr, keys, dir } = await review(repo);
      expect({ code, stderr }).toEqual({ code: 0, stderr: '' });

      const at = keys.indexOf('jev-fix#1');
      expect(keys.slice(at - 1, at + 1)).toEqual(['fix#1', 'jev-fix#1']);
      expect(keys).toContain('check-fix#1');
      const hint = jevHint(dir, 'check-fix', 1);
      expect(hint.asked).toBe(true);
      expect(hint.answers).toEqual([
        { id: 'V1', yes: 0.99 },
        { id: 'D1', yes: 0.99 },
        { id: 'R2', yes },
      ]);
      expect(asked(dir, 'jev-fix#1')).toHaveLength(1);
    });
  },
  120_000,
);

test('with no adapters.jev, check-fix runs beside validate every round as the fake seeds drive the loop', async () => {
  await withTempRepo(async (repo) => {
    setUp(repo);
    const { code, stderr, keys, dir } = await review(repo);
    expect({ code, stderr }).toEqual({ code: 0, stderr: '' });

    expect(keys.filter((key) => key.startsWith('check-fix#'))).toEqual(['check-fix#1', 'check-fix#2']);
    expect(keys.filter((key) => key.startsWith('jev-fix#'))).toEqual(['jev-fix#1', 'jev-fix#2']);
    expect([jevHint(dir, 'check-fix', 1).asked, jevHint(dir, 'check-fix', 1).answers]).toEqual([false, []]);
    expect(readEvents(dir).filter((event) => event.type === 'jev:asked')).toEqual([]);
  });
}, 120_000);

test('a low-severity finding the judge sends to a ticket is not filed, and a medium one is', async () => {
  await withTempRepo(async (repo) => {
    setUp(repo);
    const sail = join(repo.dir, '.sail');
    const [answer] = JSON.parse(readFileSync(join(sail, 'fake', 'harness.json'), 'utf8')).judge;
    const r4 = answer.output.decisions.find((each: { finding: string }) => each.finding === 'R4');
    Object.assign(r4, {
      verdict: 'ticket',
      ticket: { title: 'Rename tot', description: 'A terse name.', type: 'refactoring', trigger: 'reading show.ts' },
    });
    seedHarness(sail, 'judge', [answer]);
    const { code, stderr, dir } = await review(repo);
    expect({ code, stderr }).toEqual({ code: 0, stderr: '' });

    const folder = readdirSync(dir).find((name) => name.endsWith('-file-follow-ups'));
    const output = JSON.parse(readFileSync(join(dir, folder ?? '', 'call-1', 'result.json'), 'utf8')).output;
    expect(output.filed.map((each: { title: string }) => each.title)).toEqual([
      'sail runs sums call costs without rounding',
    ]);
  });
}, 120_000);

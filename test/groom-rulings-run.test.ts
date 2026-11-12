// sail's own `groom` workflow on a ticket its `## Rulings` settle, end to end through the CLI on the fakes: the rulings
// stage asks Jev whether the rulings answer each earlier open question, and the duplicates, worth and questions checks
// run only when they don't.
import { expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { EXIT_OK } from '../src/cli/exit-codes';
import { readJournal } from '../src/engine/journal';
import { readStatus } from '../src/engine/run-dir';
import { readEvents } from '../src/events/consumers/ndjson';
import { patchTicket, seedHarness } from './helpers/fixture';
import { fakeTicket, onlyRun, writeGroomRepo } from './helpers/groom-fixture';
import { OWN_SAIL } from './helpers/own-sail';
import { runCaptured } from './helpers/run-captured';
import { type TempRepo, withTempRepo } from './helpers/temp-repo';

const RUN = ['FAKE-2', '--workflow', 'groom'];
const COMMENT = [
  'The earlier report.',
  '',
  '## Open questions',
  '',
  '1. Should the total include the calls a seeded run reused?',
  '   - include reused: the whole cost',
  '   - **exclude reused (recommended)**: what this run spent',
  '',
  '   Why: reused calls cost nothing (`src/cli/commands/show.ts:40`)',
  '',
  '## Actions',
  '',
  '- none',
  '',
  'sail run FAKE-2-earlier groomed this ticket.',
].join('\n');
const DESCRIPTION = 'Show the cost total.\n\n## Rulings\n\n1. Exclude reused calls.\n';

/** A groom repository whose FAKE-2 holds rulings and, unless `comments` says otherwise, the earlier report. */
function ruledRepo(repo: TempRepo, options: { jev?: object | false; comments?: boolean } = {}): string {
  const jev = options.jev ?? JSON.parse(readFileSync(join(OWN_SAIL, 'fake', 'jev.json'), 'utf8'));
  const sailDir = writeGroomRepo(repo, { jev });
  const comments = options.comments === false ? [] : [{ author: 'sail', body: COMMENT }];
  patchTicket(sailDir, 'FAKE-2', { description: DESCRIPTION, comments });
  repo.git('add', '.sail/fake/tickets.json');
  repo.git('commit', '-q', '-m', 'rule FAKE-2');
  return sailDir;
}

const keysOf = (dir: string) => readJournal(dir).entries.map((entry) => entry.key);
const CHECKS = ['duplicates#1', 'worth#1', 'questions#1'];

async function groom(repo: TempRepo): Promise<string> {
  const { code, stderr } = await runCaptured(RUN, repo.dir, { env: repo.env });
  expect({ code, stderr }).toEqual({ code: EXIT_OK, stderr: '' });
  const dir = onlyRun(repo.dir);
  expect(readStatus(dir)).toEqual({ status: 'completed' });
  return dir;
}

function decideFindings(dir: string) {
  const name = readdirSync(dir).find((each) => each.endsWith('-decide')) ?? 'x';
  return JSON.parse(readFileSync(join(dir, name, 'call-1', 'in', 'findings.json'), 'utf8'));
}

test('a ruled ticket whose earlier question Jev finds answered skips the three checks', async () => {
  await withTempRepo(async (repo) => {
    ruledRepo(repo);
    const dir = await groom(repo);
    const keys = keysOf(dir);
    expect(keys.slice(0, 4)).toEqual(['intake#1', 'rulings#1', 'decide#1', 'act#1']);
    for (const key of CHECKS) expect(keys).not.toContain(key);
    expect(readJournal(dir).entries.find((entry) => entry.key === 'rulings#1')?.output).toMatchObject({
      skip: true,
      asked: true,
    });
    const findings = decideFindings(dir);
    expect(findings.duplicates).toEqual({ candidates: [] });
    expect(findings.questions).toEqual({ questions: [] });
    expect(findings.worth).toMatchObject({ verdict: 'keep', confidence: 1, stale: false, merges: [] });
    expect(findings.worth.why).toContain('checks were skipped');
    expect(readEvents(dir).some((event) => event.type === 'jev:asked' && event.key === 'rulings#1')).toBe(true);
  });
}, 120_000);

test('a cancel the judge asks for on the fast path is reported, not applied', async () => {
  await withTempRepo(async (repo) => {
    const sailDir = ruledRepo(repo);
    const [answer] = JSON.parse(readFileSync(join(sailDir, 'fake', 'harness.json'), 'utf8')).decide;
    answer.output.actions = [{ kind: 'cancel', reason: 'a tidy-up nobody would notice' }];
    answer.output.questions = [];
    seedHarness(sailDir, 'decide', [answer]);
    repo.git('add', '.sail/fake/harness.json');
    repo.git('commit', '-q', '-m', 'decide cancels');
    await groom(repo);
    const ticket = fakeTicket(repo.dir, 'FAKE-2');
    expect(ticket.state.type).toBe('unstarted');
    const comment = ticket.comments.at(-1)?.body ?? '';
    expect(comment).toContain('- reported, not marked: cancel (');
    expect(comment).not.toContain('- applied: cancel');
  });
}, 120_000);

test('one guard answer under 0.6 sends a ruled ticket down the full path', async () => {
  await withTempRepo(async (repo) => {
    const seed = JSON.parse(readFileSync(join(OWN_SAIL, 'fake', 'jev.json'), 'utf8'));
    seed.answers.Q1 = { type: 'noul', noul: 0.3 };
    ruledRepo(repo, { jev: seed });
    const dir = await groom(repo);
    expect(keysOf(dir).slice(0, 2)).toEqual(['intake#1', 'rulings#1']);
    expect(keysOf(dir)).toEqual(expect.arrayContaining(CHECKS));
    expect(readJournal(dir).entries.find((entry) => entry.key === 'rulings#1')?.output).toMatchObject({
      skip: false,
      answers: [{ id: 'Q1', yes: 0.3 }],
    });
  });
}, 120_000);

test('a ruled ticket with no earlier questions on record takes the full path and asks Jev nothing', async () => {
  await withTempRepo(async (repo) => {
    ruledRepo(repo, { comments: false });
    const dir = await groom(repo);
    expect(keysOf(dir)).toEqual(expect.arrayContaining(CHECKS));
    expect(readJournal(dir).entries.find((entry) => entry.key === 'rulings#1')?.output).toMatchObject({
      skip: false,
      asked: false,
    });
    expect(readEvents(dir).some((event) => event.type === 'jev:asked' && event.key === 'rulings#1')).toBe(false);
  });
}, 120_000);

test.each([
  ['no Jev configured', false],
  ['Jev answering 503', { error: { status: 503, detail: 'down' } }],
] as const)(
  'a ruled ticket takes the full path and completes with %s',
  async (_name, jev) => {
    await withTempRepo(async (repo) => {
      ruledRepo(repo, { jev });
      const dir = await groom(repo);
      expect(keysOf(dir)).toEqual(expect.arrayContaining(CHECKS));
      expect(readJournal(dir).entries.find((entry) => entry.key === 'rulings#1')?.output).toMatchObject({
        skip: false,
        asked: false,
      });
    });
  },
  120_000,
);

// sail's own file-follow-ups stage, as the factory and review workflows run it on the fakes: at most two tickets, bugs
// first, the rest noted; a follow-up Jev finds already open is commented there; without Jev every follow-up is filed
// unchecked; and review never files a low-severity finding.
import { expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { EXIT_OK } from '../src/cli/exit-codes';
import { seedHarness } from './helpers/fixture';
import { fakeTicket, onlyRun } from './helpers/groom-fixture';
import { nouls, OWN_SAIL, writeOwnSail } from './helpers/own-sail';
import { runCaptured } from './helpers/run-captured';
import { type TempRepo, withTempRepo } from './helpers/temp-repo';

type FollowUp = { title: string; description: string; type: string; trigger: string };

const harness = () => JSON.parse(readFileSync(join(OWN_SAIL, 'fake', 'harness.json'), 'utf8'));

/** The committed Jev seed, every follow-up question answered as `overrides` says. */
function jevSeed(overrides: Record<string, number> = {}): object {
  const seed = JSON.parse(readFileSync(join(OWN_SAIL, 'fake', 'jev.json'), 'utf8'));
  Object.assign(seed.answers, (nouls(overrides) as { answers: object }).answers);
  return seed;
}

/** sail's own `.sail/` on the fakes, describe answering with `followUps` when given, committed. */
function setUp(repo: TempRepo, options: { jev?: object; followUps?: FollowUp[] }): void {
  const sail = writeOwnSail(repo, options.jev === undefined ? {} : { jev: options.jev });
  if (options.followUps !== undefined) {
    const [answer] = harness().describe;
    answer.output.followUps = options.followUps;
    seedHarness(sail, 'describe', [answer]);
    repo.git('commit', '-am', 'seed the follow-ups');
  }
}

/** The file-follow-ups call's output. */
function filedOutput(dir: string) {
  const folder = readdirSync(dir).find((name) => name.endsWith('-file-follow-ups'));
  if (folder === undefined) throw new Error(`no file-follow-ups folder in ${dir}`);
  return JSON.parse(readFileSync(join(dir, folder, 'call-1', 'result.json'), 'utf8')).output;
}

/** The follow-ups comment on the pull request, as the fake code host holds it. */
function prComment(repoDir: string): string {
  const world = JSON.parse(readFileSync(join(repoDir, '.sail-runs', 'fake', 'prs.json'), 'utf8'));
  const bodies = Object.values(world)
    .flatMap((prs) => (Array.isArray(prs) ? prs : []))
    .flatMap((pr: { comments?: { body: string }[] }) => pr.comments ?? [])
    .map((comment) => comment.body);
  return bodies.find((body) => body.startsWith('Follow-ups:')) ?? '';
}

const follow = (title: string, type: string): FollowUp => ({
  title,
  description: `${title}, in src/x.ts.`,
  type,
  trigger: `\`sail ${type}\``,
});

test("the factory files its one follow-up Jev finds new, with how it's reached and its labels, and lists it on the pull request", async () => {
  await withTempRepo(async (repo) => {
    setUp(repo, { jev: jevSeed() });
    const { code, stderr } = await runCaptured(['FAKE-1'], repo.dir, { env: repo.env });
    expect({ code, stderr }).toEqual({ code: EXIT_OK, stderr: '' });

    const output = filedOutput(onlyRun(repo.dir));
    expect(output).toMatchObject({ existing: [], noted: [], failed: [], unchecked: null });
    expect(output.filed.map((each: { ticketKey: string }) => each.ticketKey)).toEqual(['FAKE-3']);
    const ticket = fakeTicket(repo.dir, 'FAKE-3');
    expect(ticket.labels).toEqual(['bug', 'groom']);
    expect(ticket.description).toContain('Reached by: `sail show <run>` on a run started with `--from-run`');
    expect(prComment(repo.dir)).toContain('- [FAKE-3](');
  });
}, 120_000);

test('a follow-up Jev answers at 0.8 or more as an open ticket is commented on that ticket, not filed', async () => {
  await withTempRepo(async (repo) => {
    setUp(repo, { jev: jevSeed({ 'follow-up-1:FAKE-2': 0.8 }) });
    const { code } = await runCaptured(['FAKE-1'], repo.dir, { env: repo.env });
    expect(code).toBe(EXIT_OK);

    const output = filedOutput(onlyRun(repo.dir));
    expect(output.filed).toEqual([]);
    expect(output.existing).toEqual([
      { title: "sail show's footer ignores calls replayed from a seeded run", ticketKey: 'FAKE-2', confidence: 0.8 },
    ]);
    expect(fakeTicket(repo.dir, 'FAKE-2').comments.at(-1)?.body).toContain(
      "**sail show's footer ignores calls replayed from a seeded run**",
    );
    expect(() => fakeTicket(repo.dir, 'FAKE-3')).toThrow();
  });
}, 120_000);

test('of three follow-ups the bug and the first other are filed, and the third is noted on the pull request', async () => {
  await withTempRepo(async (repo) => {
    const followUps = [
      follow('Add a flag', 'feature'),
      follow('Move a helper', 'refactoring'),
      follow('A crash', 'bug'),
    ];
    setUp(repo, {
      jev: jevSeed({
        'follow-up-1:FAKE-1': 0,
        'follow-up-1:FAKE-2': 0,
        'follow-up-2:FAKE-1': 0,
        'follow-up-2:FAKE-2': 0,
      }),
      followUps,
    });
    const { code } = await runCaptured(['FAKE-1'], repo.dir, { env: repo.env });
    expect(code).toBe(EXIT_OK);

    const output = filedOutput(onlyRun(repo.dir));
    expect(output.filed.map((each: { title: string }) => each.title)).toEqual(['A crash', 'Add a flag']);
    expect(output.noted).toEqual([{ title: 'Move a helper' }]);
    expect(prComment(repo.dir)).toContain('- noted, not filed (over 2 per run): Move a helper');
  });
}, 120_000);

test('with no Jev to ask, the follow-ups are filed unchecked, and the pull request says so', async () => {
  await withTempRepo(async (repo) => {
    setUp(repo, {});
    const { code } = await runCaptured(['FAKE-1'], repo.dir, { env: repo.env });
    expect(code).toBe(EXIT_OK);

    const output = filedOutput(onlyRun(repo.dir));
    expect(output.filed.map((each: { ticketKey: string }) => each.ticketKey)).toEqual(['FAKE-3']);
    expect(output.unchecked).toEqual(expect.any(String));
    expect(prComment(repo.dir)).toContain('Filed without the duplicate check, which failed:');
  });
}, 120_000);

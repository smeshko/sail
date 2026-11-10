// sail's own `factory` workflow, end to end through the CLI on the fakes: `sail FAKE-1` in a temporary repository that
// holds a copy of the repository's own `.sail/`, its ports all fake and, where a case seeds one, a fake Jev. The cases
// are about load-plan, which reads the plan groom attached to the ticket, and check-tasks: Jev's clear yes ends it
// without an agent session, anything else leaves it to the agent, with Jev's answers as its hint.
import { expect, test } from 'bun:test';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { EXIT_FAILED, EXIT_OK, EXIT_REFUSED } from '../src/cli/exit-codes';
import { readJournal } from '../src/engine/journal';
import { readStatus } from '../src/engine/run-dir';
import { readEvents } from '../src/events/consumers/ndjson';
import { fakeTicket, onlyRun } from './helpers/groom-fixture';
import { nouls, writeOwnSail } from './helpers/own-sail';
import { runCaptured } from './helpers/run-captured';
import { sail } from './helpers/sail-process';
import { type TempRepo, withTempRepo } from './helpers/temp-repo';

const RUN = ['FAKE-1'];

/** `sail FAKE-1` in `repo`: its exit code and stderr, and the keys its journal holds. */
async function factory(repo: TempRepo): Promise<{ code: number; stderr: string; keys: string[]; dir: string }> {
  const { code, stderr } = await runCaptured(RUN, repo.dir, { env: repo.env });
  const dir = onlyRun(repo.dir);
  return { code, stderr, keys: readJournal(dir).entries.map((entry) => entry.key), dir };
}

/** The `$STAGE_IN/jev.json` of a call, parsed. */
function jevHint(dir: string, stage: string, call: number): { asked: boolean; answers: { id: string; yes: number }[] } {
  const folder = readdirSync(dir).find((name) => name.replace(/^\d+-/, '') === stage);
  if (folder === undefined) throw new Error(`no ${stage} folder in ${dir}`);
  return JSON.parse(readFileSync(join(dir, folder, `call-${call}`, 'in', 'jev.json'), 'utf8'));
}

/** Replaces FAKE-1's attachments in the committed seed. */
function attachToFake1(repo: TempRepo, attachments: object[]): void {
  const tickets = join(repo.dir, '.sail', 'fake', 'tickets.json');
  const world = JSON.parse(readFileSync(tickets, 'utf8'));
  world.tickets.find((each: { ticketKey: string }) => each.ticketKey === 'FAKE-1').attachments = attachments;
  writeFileSync(tickets, JSON.stringify(world));
  repo.git('add', '.sail/fake/tickets.json');
  repo.git('commit', '-q', '-m', 'seed the attachments');
}

/** A plan.md as groom attaches it: a body, then its AttachedPlan trailer. */
const planFile = (n: number, body: string, trailer: object) => ({
  name: `plan.md (sail run groom-${n})`,
  url: `fake://tickets/FAKE-1/attachments/${n}`,
  mimeType: 'text/markdown',
  content: `${body}\n\n<!-- sail:plan ${JSON.stringify(trailer)} -->\n`,
});

const TASKS = [{ id: 'TASK-001', title: 'Print the total', type: 'impl', commit: 'feat(cli): print the total' }];
const trailer = (slug: string, attachedAt: string) => ({
  version: 1,
  slug,
  scope: 'cli',
  risk: 'small',
  tasks: TASKS,
  run: `groom-${slug}`,
  base: '0'.repeat(40),
  attachedAt,
});

test('a ticket with no plan attached fails at load-plan, before implement, saying groom plans it', async () => {
  await withTempRepo(async (repo) => {
    writeOwnSail(repo);
    attachToFake1(repo, [{ name: 'Figma', url: 'https://www.figma.com/file/abc' }]);
    const { code, keys, dir } = await factory(repo);
    expect(code).toBe(EXIT_FAILED);
    expect(keys).toEqual(['intake#1', 'load-plan#1', 'hand-over-ticket#1']);
    expect(readStatus(dir)).toMatchObject({ status: 'failed' });
    const loaded = readJournal(dir).entries.find((entry) => entry.key === 'load-plan#1');
    expect(loaded?.outcome).toBe('failed');
    expect(loaded?.output).toEqual({
      plan: null,
      note: 'FAKE-1 has no plan attached: label it groom, and groom plans it',
    });
    const ended = readEvents(dir).find((event) => event.type === 'run:end') as { message?: string } | undefined;
    expect(JSON.stringify(ended)).toContain('no plan: FAKE-1 has no plan attached');
    const ticket = fakeTicket(repo.dir, 'FAKE-1');
    expect(ticket.labels).toContain('needs-human');
    expect(ticket.labels).not.toContain('factory');
    expect(ticket.state.type).toBe('unstarted');
    expect(ticket.comments.at(-1)?.body).toContain('no plan: FAKE-1 has no plan attached');
  });
}, 120_000);

test('with several plans attached, load-plan leaves the one attached last as plan.md and passes over a damaged one, and implement is told to skip tasks already committed', async () => {
  await withTempRepo(async (repo) => {
    writeOwnSail(repo);
    attachToFake1(repo, [
      planFile(1, '# Plan: newer', trailer('newer-plan', '2026-11-02T09:00:00.000Z')),
      planFile(2, '# Plan: older', trailer('older-plan', '2026-11-01T09:00:00.000Z')),
      { ...planFile(3, '# Plan: damaged', {}), content: '# Plan: damaged\n\n<!-- sail:plan {"slug": oops} -->\n' },
    ]);
    const { code, stderr, keys, dir } = await factory(repo);
    expect({ code, stderr }).toEqual({ code: EXIT_OK, stderr: '' });
    expect(keys.slice(0, 3)).toEqual(['intake#1', 'load-plan#1', 'implement#1']);

    const loaded = readJournal(dir).entries.find((entry) => entry.key === 'load-plan#1');
    expect(loaded?.output).toEqual({
      plan: trailer('newer-plan', '2026-11-02T09:00:00.000Z'),
      note: expect.stringContaining('1 older plan passed over'),
    });
    expect(loaded?.output).toMatchObject({ note: expect.stringContaining('its sail:plan trailer is not JSON') });
    const plan = readFileSync(join(dir, '01-load-plan', 'call-1', 'out', 'plan.md'), 'utf8');
    expect(plan).toStartWith('# Plan: newer\n');
    const implementIn = readFileSync(join(dir, '02-implement', 'call-1', 'in', 'commit.json'), 'utf8');
    expect(JSON.parse(implementIn)).toEqual({ ticketKey: 'FAKE-1', slug: 'newer-plan', scope: 'cli' });
    const prompt = readFileSync(join(dir, '02-implement', 'call-1', 'prompt.md'), 'utf8');
    expect(prompt).toContain('git log --oneline origin/staging..HEAD');
    expect(prompt).toContain('already committed');
  });
}, 120_000);

test('the plan a groom run attaches is the plan a factory run on the same ticket implements', async () => {
  await withTempRepo(async (repo) => {
    const sailDir = writeOwnSail(repo);
    const harness = join(sailDir, 'fake', 'harness.json');
    const seeds = JSON.parse(readFileSync(harness, 'utf8'));
    seeds.decide[0].output.questions = [];
    writeFileSync(harness, JSON.stringify(seeds));
    const groomed = await runCaptured(['FAKE-2', '--workflow', 'groom'], repo.dir, { env: repo.env });
    expect({ code: groomed.code, stderr: groomed.stderr }).toEqual({ code: EXIT_OK, stderr: '' });
    const groomRun = readdirSync(join(repo.dir, '.sail-runs')).find((name) => name.startsWith('FAKE-2'));

    // A process of its own: Bun can't reload the workflow's modules in this one.
    const built = await sail(repo.dir, repo.env, ['FAKE-2']);
    expect({ code: built.code, stderr: built.stderr }).toEqual({ code: EXIT_OK, stderr: '' });
    const factoryRun = readdirSync(join(repo.dir, '.sail-runs')).find(
      (name) => name.startsWith('FAKE-2') && name !== groomRun,
    );
    const dir = join(repo.dir, '.sail-runs', factoryRun ?? '');
    const loaded = readJournal(dir).entries.find((entry) => entry.key === 'load-plan#1');
    expect(loaded?.output).toMatchObject({ plan: { run: groomRun, slug: 'show-total-cost' } });
    expect(readJournal(dir).entries.map((entry) => entry.key)).toContain('open#1');
  });
}, 240_000);

const asked = (dir: string, key: string) =>
  readEvents(dir).filter((event) => event.type === 'jev:asked' && (event as { key?: string }).key === key);

test('with Jev answering every task a clear yes, jev-tasks#1 runs, check-tasks never does, and the run goes on to describe', async () => {
  await withTempRepo(async (repo) => {
    writeOwnSail(repo, { jev: nouls({ 'TASK-001': 0.99 }) });
    const { code, stderr, keys, dir } = await factory(repo);
    expect({ code, stderr }).toEqual({ code: EXIT_OK, stderr: '' });
    expect(readStatus(dir)).toEqual({ status: 'completed' });

    expect(keys.filter((key) => key.startsWith('check-tasks#'))).toEqual([]);
    expect(keys.slice(keys.indexOf('jev-tasks#1'))).toEqual([
      'jev-tasks#1',
      'describe#1',
      'open#1',
      'file-follow-ups#1',
    ]);
    expect(asked(dir, 'jev-tasks#1')).toHaveLength(1);
  });
}, 120_000);

test.each([
  ['unclear', 0.6],
  ['a no', 0.05],
])(
  'with Jev answering the task %s, check-tasks#1 runs after jev-tasks#1 with the answers as its hint',
  async (_name, yes) => {
    await withTempRepo(async (repo) => {
      writeOwnSail(repo, { jev: nouls({ 'TASK-001': yes }) });
      const { code, stderr, keys, dir } = await factory(repo);
      expect({ code, stderr }).toEqual({ code: EXIT_OK, stderr: '' });

      const at = keys.indexOf('jev-tasks#1');
      expect(keys.slice(at, at + 2)).toEqual(['jev-tasks#1', 'check-tasks#1']);
      const hint = jevHint(dir, 'check-tasks', 1);
      expect(hint.asked).toBe(true);
      expect(hint.answers).toEqual([{ id: 'TASK-001', yes }]);
      expect(asked(dir, 'jev-tasks#1')).toHaveLength(1);
    });
  },
  120_000,
);

test('with no adapters.jev, check-tasks runs after jev-tasks on every pass as the fake seeds drive the loop', async () => {
  await withTempRepo(async (repo) => {
    writeOwnSail(repo);
    const { code, stderr, keys, dir } = await factory(repo);
    expect({ code, stderr }).toEqual({ code: EXIT_OK, stderr: '' });

    const at = keys.indexOf('jev-tasks#1');
    expect(keys.slice(at)).toEqual([
      'jev-tasks#1',
      'check-tasks#1',
      'implement#3',
      'validate#3',
      'jev-tasks#2',
      'check-tasks#2',
      'describe#1',
      'open#1',
      'file-follow-ups#1',
    ]);
    const hint = jevHint(dir, 'check-tasks', 1);
    expect([hint.asked, hint.answers]).toEqual([false, []]);
    expect(readEvents(dir).filter((event) => event.type === 'jev:asked')).toEqual([]);
  });
}, 120_000);

test('a ticket comment Linear refuses after the pull request is open still completes the run, and open#1 says commented false with its backfill', async () => {
  await withTempRepo(async (repo) => {
    writeOwnSail(repo);
    const tickets = join(repo.dir, '.sail', 'fake', 'tickets.json');
    const world = JSON.parse(readFileSync(tickets, 'utf8'));
    world.tickets.find((each: { ticketKey: string }) => each.ticketKey === 'FAKE-1').answers = {
      comment: ['ok', 'unavailable'],
    };
    writeFileSync(tickets, JSON.stringify(world));
    repo.git('add', '.sail/fake/tickets.json');
    repo.git('commit', '-q', '-m', 'script the comments');

    const { code, keys, dir } = await factory(repo);
    expect(code).toBe(EXIT_OK);
    expect(readStatus(dir)).toEqual({ status: 'completed' });
    expect(keys).toContain('file-follow-ups#1');

    const open = readJournal(dir).entries.find((entry) => entry.key === 'open#1');
    expect(open?.outcome).toBe('passed');
    const ticket = ((open?.output ?? {}) as { ticket: { commented: boolean; moved: boolean; backfill: string[] } })
      .ticket;
    expect([ticket.commented, ticket.moved, ticket.backfill.length]).toEqual([false, true, 1]);
    expect(ticket.backfill[0]).toStartWith('sail port ticket-source comment FAKE-1 --body-file ');
    const refused = readEvents(dir).filter(
      (event) => event.type === 'error:port' && (event as { key?: string }).key === 'open#1',
    );
    expect(refused.map((event) => (event as { op?: string }).op)).toEqual(['comment', 'comment', 'comment']);
  });
}, 120_000);

test('a blocked implement hands the ticket over: commented, needs-human on, factory off, back in Todo, and not started again', async () => {
  await withTempRepo(async (repo) => {
    const sailDir = writeOwnSail(repo);
    const harness = join(sailDir, 'fake', 'harness.json');
    const seeds = JSON.parse(readFileSync(harness, 'utf8'));
    seeds.implement = [{ outcome: 'blocked', reason: 'the prerequisite has not landed', messages: [], turns: 1 }];
    writeFileSync(harness, JSON.stringify(seeds));
    repo.git('add', '.sail/fake/harness.json');
    repo.git('commit', '-q', '-m', 'block implement');

    const { code, keys, dir } = await factory(repo);
    expect(code).toBe(EXIT_FAILED);
    expect(keys.at(-1)).toBe('hand-over-ticket#1');
    const handed = readJournal(dir).entries.find((entry) => entry.key === 'hand-over-ticket#1');
    expect(handed?.output).toEqual({ handedOver: true });

    const ticket = fakeTicket(repo.dir, 'FAKE-1');
    expect(ticket.state.type).toBe('unstarted');
    expect(ticket.labels).toContain('needs-human');
    expect(ticket.labels).not.toContain('factory');
    expect(ticket.comments.at(-1)?.body).toContain('implement blocked: the prerequisite has not landed');
    const moved = readEvents(dir).filter((event) => event.type === 'ticket:updated') as {
      change?: { state?: string };
    }[];
    expect(moved.map((event) => event.change?.state)).toContain('unstarted');

    const again = await sail(repo.dir, repo.env, RUN);
    expect(again.code).toBe(EXIT_REFUSED);
    expect(again.stderr).toContain("carries no 'factory' label");
  });
}, 120_000);

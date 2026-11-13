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
import { nouls, OWN_SAIL, writeOwnSail } from './helpers/own-sail';
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
    // Groom blocked FAKE-2 by FAKE-1, whose plan changes the same file, so the start passes the prerequisite by.
    const built = await sail(repo.dir, repo.env, ['FAKE-2', '--ignore-prerequisites']);
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

test('with Jev answering every task a clear yes, jev-tasks#1 runs, check-tasks never does, and the run goes on to open', async () => {
  await withTempRepo(async (repo) => {
    writeOwnSail(repo, { jev: nouls({ 'TASK-001': 0.99 }) });
    const { code, stderr, keys, dir } = await factory(repo);
    expect({ code, stderr }).toEqual({ code: EXIT_OK, stderr: '' });
    expect(readStatus(dir)).toEqual({ status: 'completed' });

    expect(keys.filter((key) => key.startsWith('check-tasks#'))).toEqual([]);
    expect(keys.slice(keys.indexOf('jev-tasks#1'))).toEqual(['jev-tasks#1', 'open#1', 'file-follow-ups#1']);
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

test('implement reporting a task with no commit and blank evidence gets a corrective try, and the run goes on once the evidence is given', async () => {
  await withTempRepo(async (repo) => {
    const sailDir = writeOwnSail(repo);
    const harness = join(sailDir, 'fake', 'harness.json');
    const seeds = JSON.parse(readFileSync(harness, 'utf8'));
    const answer = (evidence: string) => {
      const copy = structuredClone(seeds.implement[0]);
      copy.output.tasks.push({ id: 'TASK-002', commit: null, evidence });
      return copy;
    };
    seeds.implement = [answer(' '), answer('bun run types: types/ is unchanged')];
    writeFileSync(harness, JSON.stringify(seeds));
    repo.git('add', '.sail/fake/harness.json');
    repo.git('commit', '-q', '-m', 'seed a task with no commit');

    const { code, stderr, keys, dir } = await factory(repo);
    expect({ code, stderr }).toEqual({ code: EXIT_OK, stderr: '' });
    const invalid = readEvents(dir).filter(
      (event) => event.type === 'output:invalid' && (event as { key?: string }).key === 'implement#1',
    ) as { message?: string }[];
    expect(invalid).toHaveLength(1);
    expect(invalid[0]?.message).toContain('a task with no commit needs its evidence');

    const entry = readJournal(dir).entries.find((each) => each.key === 'implement#1');
    expect(entry?.outcome).toBe('done');
    const tasks = ((entry?.output ?? {}) as { tasks?: { id: string; evidence: string }[] }).tasks ?? [];
    expect(tasks.find((task) => task.id === 'TASK-002')?.evidence).toBe('bun run types: types/ is unchanged');
    expect(keys[keys.indexOf('implement#1') + 1]).toBe('validate#1');
  });
}, 120_000);

const CHECKLIST_TASKS = [
  ...TASKS,
  { id: 'TASK-002', title: 'Regenerate the types', type: 'checklist', commit: 'chore(cli): regenerate the types' },
];

/** A plan with a task that changes no file, implement reporting it with no commit, and check-tasks seeded per case. */
function seedChecklistPlan(repo: TempRepo, sailDir: string, first: boolean[], later: boolean[]): void {
  attachToFake1(repo, [
    planFile(
      1,
      [
        '# Plan: two tasks',
        '',
        '## Tasks',
        '',
        '- [ ] TASK-001: Print the total',
        '- [ ] TASK-002: Regenerate the types',
        '',
        '## Task details',
        '',
        '### TASK-001: Print the total',
        '',
        '### TASK-002: Regenerate the types',
      ].join('\n'),
      { ...trailer('two-tasks', '2026-11-02T09:00:00.000Z'), tasks: CHECKLIST_TASKS },
    ),
  ]);
  const harness = join(sailDir, 'fake', 'harness.json');
  const seeds = JSON.parse(readFileSync(harness, 'utf8'));
  seeds.implement[0].output.tasks.push({
    id: 'TASK-002',
    commit: null,
    evidence: 'bun run types: types/ is unchanged',
  });
  const checked = (implemented: boolean[]) => [
    {
      ...seeds['check-tasks'][0],
      output: {
        tasks: implemented.map((yes, at) => ({
          id: `TASK-00${at + 1}`,
          implemented: yes,
          evidence: yes ? '89541459' : 'Checklist task with no committed files',
        })),
      },
    },
  ];
  seeds['check-tasks#1'] = checked(first);
  seeds['check-tasks'] = checked(later);
  writeFileSync(harness, JSON.stringify(seeds));
  repo.git('add', '.sail/fake/harness.json');
  repo.git('commit', '-q', '-m', 'seed a task with no commit');
}

/** The `$STAGE_IN/<name>` of a call, read as the folder of `stage` holds it. */
function stageIn(dir: string, stage: string, call: number, name: string): unknown {
  return JSON.parse(readFileSync(join(callDir(dir, stage), `call-${call}`, 'in', name), 'utf8'));
}

/** The folder of `stage` in a run directory, whatever number prefix it carries. */
function callDir(dir: string, stage: string): string {
  const folder = readdirSync(dir).find((each) => each.replace(/^\d+-/, '') === stage);
  if (folder === undefined) throw new Error(`no ${stage} folder in ${dir}`);
  return join(dir, folder);
}

test('a plan with a task that changes no file reaches open: check-tasks answering it false on every call sends no pass back', async () => {
  await withTempRepo(async (repo) => {
    seedChecklistPlan(repo, writeOwnSail(repo), [true, false], [true, false]);
    const { code, stderr, keys, dir } = await factory(repo);
    expect({ code, stderr }).toEqual({ code: EXIT_OK, stderr: '' });
    expect(readStatus(dir)).toEqual({ status: 'completed' });
    expect(keys).toContain('check-tasks#1');
    expect(keys).toContain('open#1');
    expect(keys).not.toContain('implement#3');
    expect(keys).not.toContain('check-tasks#2');
    expect(stageIn(dir, 'check-tasks', 1, 'verified.json')).toEqual(['TASK-002']);
    expect(keys.slice(keys.indexOf('verification#1'))).toEqual(['verification#1', 'open#1', 'file-follow-ups#1']);
    expect(keys[keys.indexOf('verification#1') - 1]).toBe('check-tasks#1');
    const written = readFileSync(join(callDir(dir, 'verification'), 'call-1', 'out', 'pr-body.md'), 'utf8');
    expect(written).toContain('## Verification');
    expect(written).toContain('**TASK-002**');
    expect(written).toContain('bun run types: types/ is unchanged');
    expect(written).toEndWith('Closes FAKE-1\n');
    const prs = JSON.parse(readFileSync(join(repo.dir, '.sail-runs', 'fake', 'prs.json'), 'utf8'));
    // The committed seed holds a pull request of its own: the one this run opened is the one that carries the section.
    const opened = (prs.pullRequests as { body: string }[]).filter((pr) => pr.body.includes('## Verification'));
    expect(opened).toHaveLength(1);
    expect(opened[0]?.body).toContain('bun run types: types/ is unchanged');
  });
}, 120_000);

test('a plan with a task that changes no file, with Jev clear on the other, asks only about the other and skips check-tasks', async () => {
  await withTempRepo(async (repo) => {
    seedChecklistPlan(repo, writeOwnSail(repo, { jev: nouls({ 'TASK-001': 0.99 }) }), [false, false], [false, false]);
    const { code, stderr, keys, dir } = await factory(repo);
    expect({ code, stderr }).toEqual({ code: EXIT_OK, stderr: '' });
    expect(keys.filter((key) => key.startsWith('check-tasks#'))).toEqual([]);
    expect(keys.slice(keys.indexOf('jev-tasks#1'))).toEqual([
      'jev-tasks#1',
      'verification#1',
      'open#1',
      'file-follow-ups#1',
    ]);
    expect(stageIn(dir, 'jev-tasks', 1, 'verified.json')).toEqual(['TASK-002']);
    const request = JSON.parse(
      readFileSync(join(callDir(dir, 'jev-tasks'), 'call-1', 'out', 'jev-request.json'), 'utf8'),
    );
    expect(Object.keys(request.questions)).toEqual(['TASK-001']);
  });
}, 120_000);

test('a task with no commit is listed as implemented in the feedback of a pass another task sent back', async () => {
  await withTempRepo(async (repo) => {
    seedChecklistPlan(repo, writeOwnSail(repo), [false, false], [true, false]);
    const { code, keys, dir } = await factory(repo);
    expect(code).toBe(EXIT_OK);
    const at = keys.indexOf('implement#3');
    expect(at).toBeGreaterThan(-1);
    expect(keys.slice(at)).toContain('check-tasks#2');
    expect(keys.indexOf('check-tasks#2')).toBeLessThan(keys.indexOf('open#1'));
    const feedback = stageIn(dir, 'implement', 3, 'feedback.json') as { tasks: { tasks: unknown[] } };
    expect(feedback.tasks.tasks).toEqual([
      { id: 'TASK-001', implemented: false, evidence: 'Checklist task with no committed files' },
      { id: 'TASK-002', implemented: true, evidence: "no commit: accepted on implement's evidence" },
    ]);
  });
}, 120_000);

test('a task with no commit stays accepted on its first evidence when a later pass leaves it out', async () => {
  await withTempRepo(async (repo) => {
    const sailDir = writeOwnSail(repo);
    seedChecklistPlan(repo, sailDir, [false, false], [true, false]);
    // Only the first pass reports TASK-002: every later implement answer reports TASK-001 alone.
    const harness = join(sailDir, 'fake', 'harness.json');
    const seeds = JSON.parse(readFileSync(harness, 'utf8'));
    seeds['implement#1'] = [seeds.implement[0]];
    seeds.implement = [
      {
        ...seeds.implement[0],
        output: {
          ...seeds.implement[0].output,
          tasks: seeds.implement[0].output.tasks.filter((task: { id: string }) => task.id !== 'TASK-002'),
        },
      },
    ];
    writeFileSync(harness, JSON.stringify(seeds));
    repo.git('add', '.sail/fake/harness.json');
    repo.git('commit', '-q', '-m', 'leave the task with no commit out of later passes');

    const { code, stderr, keys, dir } = await factory(repo);
    expect({ code, stderr }).toEqual({ code: EXIT_OK, stderr: '' });
    expect(stageIn(dir, 'check-tasks', 2, 'verified.json')).toEqual(['TASK-002']);
    expect(keys).toContain('open#1');
    const written = readFileSync(join(callDir(dir, 'verification'), 'call-1', 'out', 'pr-body.md'), 'utf8');
    expect(written).toContain('bun run types: types/ is unchanged');
  });
}, 120_000);

test('implement gets AGENTS.md and CONTEXT.md and check-tasks none', async () => {
  await withTempRepo(async (repo) => {
    writeOwnSail(repo);
    const { code, stderr, keys, dir } = await factory(repo);
    expect({ code, stderr }).toEqual({ code: EXIT_OK, stderr: '' });
    expect(keys).toContain('check-tasks#1');
    const conventionsOf = (key: string) =>
      (
        readEvents(dir).find((event) => event.type === 'prompt:rendered' && event.key === key) as
          | { conventions?: string[] }
          | undefined
      )?.conventions;
    expect(conventionsOf('implement#1')).toEqual(['AGENTS.md', 'CONTEXT.md']);
    expect(conventionsOf('check-tasks#1')).toEqual([]);
  });
}, 120_000);

/** The committed `implement` answer: its title, its follow-ups and its `pr-body.md`. */
const implementSeed = (): { output: { title: string; followUps: unknown[] }; files: { 'pr-body.md': string } } =>
  JSON.parse(readFileSync(join(OWN_SAIL, 'fake', 'harness.json'), 'utf8')).implement[0];

test("implement's prompt asks for the pull request's body and its sections", async () => {
  await withTempRepo(async (repo) => {
    writeOwnSail(repo, { jev: nouls({ 'TASK-001': 0.99 }) });
    const { code, stderr, dir } = await factory(repo);
    expect({ code, stderr }).toEqual({ code: EXIT_OK, stderr: '' });
    const prompt = readFileSync(join(dir, '02-implement', 'call-1', 'prompt.md'), 'utf8');
    for (const part of [
      '$STAGE_OUT/pr-body.md',
      '**Summary**',
      '**Changes**',
      '**Testing**',
      '**Demonstration**',
      '**Follow-ups**',
      'Closes FAKE-1',
      'git log origin/staging..HEAD',
      'ending with `(FAKE-1)`',
    ]) {
      expect(prompt).toContain(part);
    }
  });
}, 120_000);

test('implement#1 is journaled with its title, its follow-ups and pr-body.md', async () => {
  await withTempRepo(async (repo) => {
    writeOwnSail(repo, { jev: nouls({ 'TASK-001': 0.99 }) });
    const { code, stderr, dir } = await factory(repo);
    expect({ code, stderr }).toEqual({ code: EXIT_OK, stderr: '' });
    const seed = implementSeed();
    const entry = readJournal(dir).entries.find((each) => each.key === 'implement#1');
    const output = (entry?.output ?? {}) as { title?: string; followUps?: unknown[] };
    expect(output.title).toBe("feat(cli): print the run's total cost in sail show's footer (FAKE-1)");
    expect(output.title).toBe(seed.output.title);
    expect(output.followUps).toHaveLength(1);
    expect(Object.keys(entry?.files ?? {})).toEqual(['pr-body.md']);
    const written = readFileSync(join(dir, '02-implement', 'call-1', 'out', 'pr-body.md'), 'utf8');
    expect(written).toBe(seed.files['pr-body.md']);
    expect(written).toContain('## Demonstration');
  });
}, 120_000);

test('an implement pass that submits without pr-body.md gets a corrective try, and the run goes on once the file is there', async () => {
  await withTempRepo(async (repo) => {
    const sailDir = writeOwnSail(repo, { jev: nouls({ 'TASK-001': 0.99 }) });
    const harness = join(sailDir, 'fake', 'harness.json');
    const seeds = JSON.parse(readFileSync(harness, 'utf8'));
    const { files: _files, ...withoutBody } = seeds.implement[0];
    seeds['implement#1'] = [withoutBody, seeds.implement[0]];
    writeFileSync(harness, JSON.stringify(seeds));
    repo.git('add', '.sail/fake/harness.json');
    repo.git('commit', '-q', '-m', 'seed a pass with no body');

    const { code, stderr, keys, dir } = await factory(repo);
    expect({ code, stderr }).toEqual({ code: EXIT_OK, stderr: '' });
    const events = readEvents(dir).filter((event) => (event as { key?: string }).key === 'implement#1');
    const starts = events.filter((event) => event.type === 'stage:start') as { try?: number }[];
    expect(starts.map((event) => event.try)).toEqual([1, 2]);
    const refused = events.filter((event) =>
      JSON.stringify(event).includes("'pr-body.md' was not produced in $STAGE_OUT"),
    );
    expect(refused).toHaveLength(1);

    const entry = readJournal(dir).entries.find((each) => each.key === 'implement#1');
    expect(entry?.outcome).toBe('done');
    expect(Object.keys(entry?.files ?? {})).toEqual(['pr-body.md']);
    expect(keys[keys.indexOf('implement#1') + 1]).toBe('validate#1');
  });
}, 120_000);

type OpenedPr = { number: number; title: string; body: string };
const prsIn = (path: string): OpenedPr[] => JSON.parse(readFileSync(path, 'utf8')).pullRequests;

/** The pull requests the run opened: the committed seed holds one of its own, with the seeded title. */
function openedBy(repo: TempRepo): OpenedPr[] {
  const seeded = new Set(prsIn(join(OWN_SAIL, 'fake', 'prs.json')).map((pr) => pr.number));
  return prsIn(join(repo.dir, '.sail-runs', 'fake', 'prs.json')).filter((pr) => !seeded.has(pr.number));
}

test("a factory run makes no describe call and opens the pull request with implement's title and body", async () => {
  await withTempRepo(async (repo) => {
    writeOwnSail(repo, { jev: nouls({ 'TASK-001': 0.99 }) });
    const { code, stderr, keys, dir } = await factory(repo);
    expect({ code, stderr }).toEqual({ code: EXIT_OK, stderr: '' });
    expect(keys.filter((key) => key.startsWith('describe#'))).toEqual([]);

    const seed = implementSeed();
    const opened = openedBy(repo);
    expect(opened.map((pr) => pr.title)).toEqual([seed.output.title]);
    expect(opened[0]?.body).toBe(seed.files['pr-body.md']);
    for (const heading of ['## Summary', '## Changes', '## Testing', '## Demonstration']) {
      expect(opened[0]?.body).toContain(`${heading}\n`);
    }
    expect(opened[0]?.body).toEndWith('Closes FAKE-1\n');

    // The follow-up implement submitted reaches file-follow-ups once the pull request is open.
    expect(keys.slice(keys.indexOf('open#1'))).toEqual(['open#1', 'file-follow-ups#1']);
    const filed = readJournal(dir).entries.find((entry) => entry.key === 'file-follow-ups#1');
    expect(filed?.outcome).toBe('passed');
    // Filed, or skipped as a duplicate by the fake Jev: either way the stage was handed implement's follow-up.
    expect(JSON.stringify(filed?.output)).toContain("sail show's footer ignores calls replayed from a seeded run");
  });
}, 120_000);

test("a run of several implement passes opens the pull request with the last pass's body and title", async () => {
  await withTempRepo(async (repo) => {
    const sailDir = writeOwnSail(repo);
    const harness = join(sailDir, 'fake', 'harness.json');
    const seeds = JSON.parse(readFileSync(harness, 'utf8'));
    const first = structuredClone(seeds.implement[0]);
    first.output.title = 'feat(cli): first pass (FAKE-1)';
    first.files['pr-body.md'] = 'FIRST PASS ONLY\n\nCloses FAKE-1\n';
    seeds['implement#1'] = [first];
    writeFileSync(harness, JSON.stringify(seeds));
    repo.git('add', '.sail/fake/harness.json');
    repo.git('commit', '-q', '-m', 'seed a first pass with a body of its own');

    const { code, stderr, keys, dir } = await factory(repo);
    expect({ code, stderr }).toEqual({ code: EXIT_OK, stderr: '' });
    expect(keys).toContain('implement#3');
    expect(readFileSync(join(dir, '02-implement', 'call-1', 'out', 'pr-body.md'), 'utf8')).toStartWith(
      'FIRST PASS ONLY',
    );

    const seed = implementSeed();
    const opened = openedBy(repo);
    expect(opened.filter((pr) => pr.body.includes('FIRST PASS ONLY'))).toEqual([]);
    expect(opened.filter((pr) => pr.title === 'feat(cli): first pass (FAKE-1)')).toEqual([]);
    expect(opened.map((pr) => pr.title)).toEqual([seed.output.title]);
    expect(opened[0]?.body).toBe(seed.files['pr-body.md']);
  });
}, 120_000);

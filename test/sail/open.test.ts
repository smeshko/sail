// sail's own factory open stage, run as a script on the fakes: the ticket comment and the move to In Review are tried
// three times each and a miss is reported with its backfill command rather than failing the step, since the pull
// request is already open.
import { expect, test } from 'bun:test';
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { writeOwnSail } from '../helpers/own-sail';
import { type TempRepo, withTempRepo } from '../helpers/temp-repo';

const ROOT = join(import.meta.dir, '..', '..');

interface Opened {
  number: number;
  url: string;
  draft: boolean;
  ticket: { commented: boolean; moved: boolean; backfill: string[] };
}

interface Answers {
  comment?: string[];
  update?: string[];
}

/** `repo` on a branch with a commit of its own, and FAKE-1 In Progress carrying `answers`. */
function prepare(repo: TempRepo, answers?: Answers): void {
  writeOwnSail(repo);
  repo.git('checkout', '-q', '-b', 'sail/FAKE-1-open');
  writeFileSync(join(repo.dir, 'change.txt'), 'change\n');
  repo.git('add', 'change.txt');
  repo.git('commit', '-q', '-m', 'a change');
  const tickets = join(repo.dir, '.sail', 'fake', 'tickets.json');
  const world = JSON.parse(readFileSync(tickets, 'utf8'));
  const fake = world.tickets.find((each: { ticketKey: string }) => each.ticketKey === 'FAKE-1');
  fake.state = { type: 'started', name: 'In Progress' };
  fake.comments = [];
  if (answers !== undefined) fake.answers = answers;
  writeFileSync(tickets, JSON.stringify(world));
}

function env(repo: TempRepo, extra: Record<string, string> = {}): Record<string, string> {
  return {
    ...repo.env,
    ...extra,
    PATH: `${join(ROOT, 'bin')}:${repo.env.PATH ?? ''}`,
    SAIL_BUN: process.execPath,
    SAIL_CONFIG: join(repo.dir, '.sail', 'project.yaml'),
  };
}

/** Runs the open stage's run.sh in `repo`: its exit code, stderr, and its last stdout line parsed. */
function runOpen(repo: TempRepo): { code: number; stderr: string; output: Opened; out: string } {
  const out = join(repo.home, `stage-out-${Date.now()}`);
  mkdirSync(out);
  const real = realpathSync(out);
  const inputs: Record<string, string> = {};
  for (const [name, text] of [
    ['INPUT_TITLE', 'feat(cli): open'],
    ['INPUT_BODY', '## Summary\n\nOpens.\n'],
    ['INPUT_TICKETKEY', 'FAKE-1'],
  ] as const) {
    inputs[name] = join(out, `${name}.in`);
    writeFileSync(inputs[name], text);
  }
  const child = Bun.spawnSync([join(repo.dir, '.sail', 'workflows', 'factory', 'stages', '06-open', 'run.sh')], {
    cwd: repo.dir,
    env: env(repo, { ...inputs, BRANCH: 'sail/FAKE-1-open', RUN_ID: 'FAKE-1-RUN', STAGE_OUT: out }),
  });
  const lines = child.stdout.toString().trim().split('\n');
  return {
    code: child.exitCode ?? -1,
    stderr: child.stderr.toString(),
    output: JSON.parse(child.exitCode === 0 ? (lines.at(-1) ?? 'null') : 'null'),
    out: real,
  };
}

/** `sail port ticket-source get FAKE-1` in `repo`. */
function ticket(repo: TempRepo): { state: { name: string }; comments: { body: string }[] } {
  const child = Bun.spawnSync([join(ROOT, 'bin', 'sail'), 'port', 'ticket-source', 'get', 'FAKE-1'], {
    cwd: repo.dir,
    env: env(repo),
  });
  return JSON.parse(child.stdout.toString().trim().split('\n').at(-1) ?? 'null');
}

test('with both ticket changes taking, open prints the pull request with ticket commented, moved and no backfill', async () => {
  await withTempRepo(async (repo) => {
    prepare(repo);
    const { code, output, stderr } = runOpen(repo);
    expect(code).toBe(0);
    expect(output.ticket).toEqual({ commented: true, moved: true, backfill: [] });
    expect(output.url).toStartWith('fake://codehost/');
    expect(stderr).not.toContain('backfill');
    const after = ticket(repo);
    expect(after.state.name).toBe('In Review');
    expect(after.comments.map((each) => each.body)).toEqual([`sail run FAKE-1-RUN opened ${output.url}`]);
  });
}, 60_000);

test('a comment refused three times leaves the step passing, commented false, and a backfill command that posts it when run', async () => {
  await withTempRepo(async (repo) => {
    prepare(repo, { comment: ['unavailable', 'unavailable', 'unavailable', 'ok'] });
    const { code, output, stderr, out } = runOpen(repo);
    expect(code).toBe(0);
    const command = `sail port ticket-source comment FAKE-1 --body-file '${join(out, 'comment.md')}'`;
    expect(output.ticket).toEqual({ commented: false, moved: true, backfill: [command] });
    expect(stderr).toContain(`the ticket comment failed; backfill it with: ${command}`);
    expect(ticket(repo).comments).toEqual([]);

    const backfill = Bun.spawnSync(['bash', '-c', command.replace('sail port', `${join(ROOT, 'bin', 'sail')} port`)], {
      cwd: repo.dir,
      env: env(repo),
    });
    expect(backfill.exitCode).toBe(0);
    expect(ticket(repo).comments.map((each) => each.body)).toEqual([`sail run FAKE-1-RUN opened ${output.url}`]);
  });
}, 60_000);

test('a move refused three times leaves the step passing, moved false, and an update backfill that moves it when run', async () => {
  await withTempRepo(async (repo) => {
    prepare(repo, { update: ['unavailable', 'unavailable', 'unavailable', 'ok'] });
    const { code, output, stderr } = runOpen(repo);
    expect(code).toBe(0);
    const command = 'sail port ticket-source update FAKE-1 --state in-review';
    expect(output.ticket).toEqual({ commented: true, moved: false, backfill: [command] });
    expect(stderr).toContain(`the move to in review failed; backfill it with: ${command}`);
    expect(ticket(repo).state.name).toBe('In Progress');

    const backfill = Bun.spawnSync(['bash', '-c', command.replace('sail port', `${join(ROOT, 'bin', 'sail')} port`)], {
      cwd: repo.dir,
      env: env(repo),
    });
    expect(backfill.exitCode).toBe(0);
    expect(ticket(repo).state.name).toBe('In Review');
  });
}, 60_000);

test('both refused: both backfill commands, comment first, and the step still exits 0', async () => {
  await withTempRepo(async (repo) => {
    prepare(repo, { comment: ['unavailable'], update: ['unavailable'] });
    const { code, output, out } = runOpen(repo);
    expect(code).toBe(0);
    expect(output.ticket).toEqual({
      commented: false,
      moved: false,
      backfill: [
        `sail port ticket-source comment FAKE-1 --body-file '${join(out, 'comment.md')}'`,
        'sail port ticket-source update FAKE-1 --state in-review',
      ],
    });
  });
}, 60_000);

test('a comment refused twice and then taken counts as commented, with no backfill', async () => {
  await withTempRepo(async (repo) => {
    prepare(repo, { comment: ['unavailable', 'unavailable', 'ok'] });
    const { code, output } = runOpen(repo);
    expect(code).toBe(0);
    expect(output.ticket).toEqual({ commented: true, moved: true, backfill: [] });
    expect(ticket(repo).comments).toHaveLength(1);
  });
}, 60_000);

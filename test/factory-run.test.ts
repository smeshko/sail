// sail's own `factory` workflow, end to end through the CLI on the fakes: `sail FAKE-1` in a temporary repository that
// holds a copy of the repository's own `.sail/`, its ports all fake and, where a case seeds one, a fake Jev. The cases
// are about check-tasks: Jev's clear yes ends it without an agent session, anything else leaves it to the agent, with
// Jev's answers as its hint.
import { expect, test } from 'bun:test';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { EXIT_OK } from '../src/cli/exit-codes';
import { readJournal } from '../src/engine/journal';
import { readStatus } from '../src/engine/run-dir';
import { readEvents } from '../src/events/consumers/ndjson';
import { onlyRun } from './helpers/groom-fixture';
import { nouls, writeOwnSail } from './helpers/own-sail';
import { runCaptured } from './helpers/run-captured';
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

// Who claims the ticket (ADW-351): opening a run moves nothing, a repository intake that never claims leaves the ticket
// as it was, and one that runs `sail port ticket-source claim` moves it to In Progress.
import { expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createFakeTicketSource } from '../../src/adapters/fake/ticket-source';
import { EXIT_OK } from '../../src/cli/exit-codes';
import { copyFixture, edit, seedHarness, writeOwnIntake } from '../helpers/fixture';
import { runCaptured } from '../helpers/run-captured';
import { withTempRepo } from '../helpers/temp-repo';

const SHAPED = { outcome: 'done', output: { title: 'Groomed FAKE-1' }, messages: ['Titled.'] };

/** A repository whose `groom` intake fetches and shapes, run on FAKE-1. */
async function groom(repoDir: string, claims: boolean) {
  const sail = copyFixture(repoDir);
  writeOwnIntake(sail);
  seedHarness(sail, 'intake/shape', [SHAPED]);
  if (claims) {
    edit(
      join(sail, 'workflows', 'groom'),
      'fetch.sh',
      'echo "# Brief for $key"',
      'sail port ticket-source claim "$key" >/dev/null\necho "# Brief for $key"',
    );
  }
  const run = await runCaptured(['FAKE-1', '--workflow', 'groom'], repoDir);
  expect([run.code, run.stderr]).toEqual([EXIT_OK, '']);
  const runs = join(repoDir, '.sail-runs');
  const [id = ''] = readdirSync(runs).filter((name) => name !== 'fake');
  const header = JSON.parse(readFileSync(join(runs, id, 'run.json'), 'utf8'));
  const ticket = await createFakeTicketSource({
    seed: join(sail, 'fake', 'tickets.json'),
    state: join(runs, 'fake', 'tickets.json'),
  }).get('FAKE-1');
  return { header, ticket };
}

test('a repository intake that never claims leaves FAKE-1 in Todo with its comments as they were, and run.json holds no claim', async () => {
  await withTempRepo(async (repo) => {
    const seed = join(copyFixture(repo.dir), 'fake', 'tickets.json');
    const before = await createFakeTicketSource({ seed, state: join(repo.dir, 'untouched.json') }).get('FAKE-1');
    const { header, ticket } = await groom(repo.dir, false);
    expect(ticket.state).toEqual({ type: 'unstarted', name: 'Todo' });
    expect(ticket.comments).toEqual(before.comments);
    expect('claim' in header).toBe(false);
  });
}, 60_000);

test('a repository intake that runs sail port ticket-source claim moves FAKE-1 to In Progress, and run.json still holds no claim', async () => {
  await withTempRepo(async (repo) => {
    const { header, ticket } = await groom(repo.dir, true);
    expect(ticket.state).toEqual({ type: 'started', name: 'In Progress' });
    expect('claim' in header).toBe(false);
  });
}, 60_000);

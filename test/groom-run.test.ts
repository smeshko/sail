// sail's own `groom` workflow, end to end through the CLI on the fakes: `sail FAKE-2 --workflow groom` in a temporary
// repository that holds a copy of the repository's own `.sail/`, its ports all fake (.sail/fake/*.json).
import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createFakeCodeHost } from '../src/adapters/fake/code-host';
import { createFakeTicketSource } from '../src/adapters/fake/ticket-source';
import { EXIT_OK, EXIT_REFUSED } from '../src/cli/exit-codes';
import { readJournal } from '../src/engine/journal';
import { readStatus } from '../src/engine/run-dir';
import { readEvents } from '../src/events/consumers/ndjson';
import { openWatchTarget, pollOnce } from '../src/watch/poll';
import { fakeTicket, onlyRun, writeGroomRepo } from './helpers/groom-fixture';
import { runCaptured } from './helpers/run-captured';
import { sail } from './helpers/sail-process';
import { withTempRepo } from './helpers/temp-repo';

const RUN = ['FAKE-2', '--workflow', 'groom'];

test('a groom run on fakes reads FAKE-2 unclaimed, comments the report and takes the label off, leaving it in Backlog', async () => {
  await withTempRepo(async (repo) => {
    writeGroomRepo(repo);
    const { code, stderr } = await runCaptured(RUN, repo.dir, { env: repo.env });
    expect({ code, stderr }).toEqual({ code: EXIT_OK, stderr: '' });

    const dir = onlyRun(repo.dir);
    expect(readStatus(dir)).toEqual({ status: 'completed' });
    const keys = readJournal(dir).entries.map((entry) => entry.key);
    expect(keys[0]).toBe('intake#1');
    expect(keys.slice(1, 4).sort()).toEqual(['duplicates#1', 'questions#1', 'staleness#1']);
    expect(keys.slice(4)).toEqual(['decide#1', 'act#1']);

    const ticket = fakeTicket(repo.dir, 'FAKE-2');
    expect(ticket.state).toEqual({ type: 'unstarted', name: 'Backlog' });
    expect(ticket.labels).not.toContain('groom');
    const seeded = ticket.comments.length;
    const comment = ticket.comments.at(-1)?.body ?? '';
    for (const heading of ['## Duplicates', '## Staleness', '## Open questions', '## Actions']) {
      expect(comment).toContain(heading);
    }
    expect(seeded).toBe(2);

    const types = readEvents(dir).map((event) => event.type);
    expect(types).not.toContain('ticket:claimed');
    expect(types).not.toContain('ticket:updated');
    const unlabelled = readEvents(dir).filter((event) => event.type === 'ticket:unlabelled');
    expect(unlabelled.map((event) => (event as { label?: string }).label)).toEqual(['groom']);
  });
}, 120_000);

test("groom's intake wraps the ticket and the other tickets as untrusted input", async () => {
  await withTempRepo(async (repo) => {
    writeGroomRepo(repo);
    const { code } = await runCaptured(RUN, repo.dir, { env: repo.env });
    expect(code).toBe(EXIT_OK);

    const call = join(onlyRun(repo.dir), '00-intake', 'call-1');
    const brief = readFileSync(join(call, 'brief.md'), 'utf8');
    const others = readFileSync(join(call, 'others.md'), 'utf8');
    expect(brief).toContain('<untrusted-input source="ticket FAKE-2, description">');
    expect(others).toContain('<untrusted-input source="ticket FAKE-1, title">');
    expect(others).not.toContain('FAKE-2');
  });
}, 120_000);

test('after a groom run, a rerun is refused and a poll queues nothing', async () => {
  await withTempRepo(async (repo) => {
    const sailDir = writeGroomRepo(repo);
    const first = await runCaptured(RUN, repo.dir, { env: repo.env });
    expect(first.code).toBe(EXIT_OK);

    // A process of its own: Bun can't reload the workflow's modules in this one.
    const again = await sail(repo.dir, repo.env, RUN);
    expect(again.code).toBe(EXIT_REFUSED);
    expect(again.stderr).toContain("carries no 'groom' label");

    const now = () => new Date('2026-10-14T09:00:00.000Z');
    const ticketSource = createFakeTicketSource({
      seed: join(sailDir, 'fake', 'tickets.json'),
      state: join(repo.dir, '.sail-runs', 'fake', 'tickets.json'),
    });
    const codeHost = createFakeCodeHost({
      seed: join(sailDir, 'fake', 'prs.json'),
      state: join(repo.dir, '.sail-runs', 'fake', 'prs.json'),
      env: {},
    });
    const target = await openWatchTarget({
      sailDir,
      config: { label: 'factory' },
      name: 'groom',
      ticketSource,
      codeHost,
      now,
    });
    if ('refused' in target) throw new Error(target.refused);
    expect(target.label).toBe('groom');
    expect(await pollOnce(target, now)).toBe('polled');
    expect(target.store.snapshot().items).toEqual([]);
  });
}, 120_000);

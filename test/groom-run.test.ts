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
import { edit, seedHarness } from './helpers/fixture';
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

const NEW_TITLE = "Show the run's total cost in sail show's footer";

/** The comment groom left on FAKE-2: its last. */
const lastComment = (repoDir: string) => fakeTicket(repoDir, 'FAKE-2').comments.at(-1)?.body ?? '';

/** Reseeds the `duplicates` check's one candidate with `confidence`. */
function seedDuplicate(sailDir: string, confidence: number): void {
  const [answer] = JSON.parse(readFileSync(join(sailDir, 'fake', 'harness.json'), 'utf8')).duplicates;
  answer.output.candidates[0].confidence = confidence;
  seedHarness(sailDir, 'duplicates', [answer]);
}

test("groom applies the judge's edit and reports a duplicate under the threshold without marking it", async () => {
  await withTempRepo(async (repo) => {
    writeGroomRepo(repo);
    const { code, stderr } = await runCaptured(RUN, repo.dir, { env: repo.env });
    expect({ code, stderr }).toEqual({ code: EXIT_OK, stderr: '' });

    const ticket = fakeTicket(repo.dir, 'FAKE-2');
    expect(ticket.description).toBe(
      "`sail show` should say what a run spent. Add the total of every call's cost at the end of its output.",
    );
    expect(ticket.title).toBe(NEW_TITLE);
    expect(ticket.state).toEqual({ type: 'unstarted', name: 'Backlog' });
    expect(ticket.links).toEqual([]);
    const comment = lastComment(repo.dir);
    expect(comment).toContain('- applied: edit title');
    expect(comment).toContain('- reported, not marked: duplicate of FAKE-1 (confidence 0.60, under 0.80)');
    const types = readEvents(onlyRun(repo.dir)).map((event) => event.type);
    expect(types).toContain('ticket:edited');
    expect(types).not.toContain('ticket:related');
  });
}, 120_000);

test('groom applies a title-only edit to a ticket with no description, and leaves the description empty', async () => {
  await withTempRepo(async (repo) => {
    const sailDir = writeGroomRepo(repo);
    edit(
      sailDir,
      'fake/tickets.json',
      `"description": "\`sail show\` should say what a run spent. Add the total of every call's cost at the end of its output."`,
      '"description": ""',
    );
    repo.git('commit', '-am', 'FAKE-2 has no description');
    const { code, stderr } = await runCaptured(RUN, repo.dir, { env: repo.env });
    expect({ code, stderr }).toEqual({ code: EXIT_OK, stderr: '' });

    const ticket = fakeTicket(repo.dir, 'FAKE-2');
    expect([ticket.title, ticket.description]).toEqual([NEW_TITLE, '']);
    expect(lastComment(repo.dir)).toContain('- applied: edit title');
  });
}, 120_000);

test('groom reports an edit that names neither a title nor a description, and edits nothing', async () => {
  await withTempRepo(async (repo) => {
    const sailDir = writeGroomRepo(repo);
    const [answer] = JSON.parse(readFileSync(join(sailDir, 'fake', 'harness.json'), 'utf8')).decide;
    answer.output.actions = [{ kind: 'edit' }];
    seedHarness(sailDir, 'decide', [answer]);
    const { code, stderr } = await runCaptured(RUN, repo.dir, { env: repo.env });
    expect({ code, stderr }).toEqual({ code: EXIT_OK, stderr: '' });

    const comment = lastComment(repo.dir);
    expect(comment).toContain('- reported, not marked: edit (names neither a title nor a description)');
    expect(comment).not.toContain('- applied:');
    expect(readEvents(onlyRun(repo.dir)).map((event) => event.type)).not.toContain('ticket:edited');
  });
}, 120_000);

test('groom marks a duplicate the check named at or above the threshold', async () => {
  await withTempRepo(async (repo) => {
    const sailDir = writeGroomRepo(repo);
    seedDuplicate(sailDir, 0.95);
    const { code, stderr } = await runCaptured(RUN, repo.dir, { env: repo.env });
    expect({ code, stderr }).toEqual({ code: EXIT_OK, stderr: '' });

    const ticket = fakeTicket(repo.dir, 'FAKE-2');
    expect(ticket.links.map((link) => link.title?.split(':')[0])).toEqual(['duplicate FAKE-1']);
    expect(ticket.state.type).toBe('canceled');
    expect(lastComment(repo.dir)).toContain('- applied: duplicate FAKE-1');
    const related = readEvents(onlyRun(repo.dir)).filter((event) => event.type === 'ticket:related');
    expect(related.map((event) => (event as { kind?: string }).kind)).toEqual(['duplicate']);
  });
}, 120_000);

test('groom marks a duplicate the check named at exactly the threshold', async () => {
  await withTempRepo(async (repo) => {
    const sailDir = writeGroomRepo(repo);
    seedDuplicate(sailDir, 0.8);
    const { code, stderr } = await runCaptured(RUN, repo.dir, { env: repo.env });
    expect({ code, stderr }).toEqual({ code: EXIT_OK, stderr: '' });

    expect(fakeTicket(repo.dir, 'FAKE-2').state.type).toBe('canceled');
    expect(lastComment(repo.dir)).toContain('- applied: duplicate FAKE-1');
  });
}, 120_000);

test('groom reports, never marks, a duplicate of a ticket the check did not name', async () => {
  await withTempRepo(async (repo) => {
    const sailDir = writeGroomRepo(repo);
    const [answer] = JSON.parse(readFileSync(join(sailDir, 'fake', 'harness.json'), 'utf8')).duplicates;
    answer.output.candidates = [];
    seedHarness(sailDir, 'duplicates', [answer]);
    const { code, stderr } = await runCaptured(RUN, repo.dir, { env: repo.env });
    expect({ code, stderr }).toEqual({ code: EXIT_OK, stderr: '' });

    const ticket = fakeTicket(repo.dir, 'FAKE-2');
    expect(ticket.state.type).toBe('unstarted');
    expect(ticket.links).toEqual([]);
    expect(lastComment(repo.dir)).toContain(
      '- reported, not marked: duplicate of FAKE-1 (not named by the duplicates check)',
    );
  });
}, 120_000);

test('groom marks only the first duplicate, and reports a second', async () => {
  await withTempRepo(async (repo) => {
    const sailDir = writeGroomRepo(repo);
    seedDuplicate(sailDir, 0.95);
    const [answer] = JSON.parse(readFileSync(join(sailDir, 'fake', 'harness.json'), 'utf8')).decide;
    answer.output.actions = [
      { kind: 'duplicate', of: 'FAKE-1' },
      { kind: 'duplicate', of: 'FAKE-1' },
    ];
    seedHarness(sailDir, 'decide', [answer]);
    const { code, stderr } = await runCaptured(RUN, repo.dir, { env: repo.env });
    expect({ code, stderr }).toEqual({ code: EXIT_OK, stderr: '' });

    const related = readEvents(onlyRun(repo.dir)).filter((event) => event.type === 'ticket:related');
    expect(related).toHaveLength(1);
    const comment = lastComment(repo.dir);
    expect(comment).toContain('- applied: duplicate FAKE-1');
    expect(comment).toContain(
      '- reported, not marked: duplicate of FAKE-1 (confidence 0.95, a duplicate is already marked)',
    );
  });
}, 120_000);

test('an action the port refuses is reported as failed, and the ticket is still commented and unlabelled', async () => {
  await withTempRepo(async (repo) => {
    const sailDir = writeGroomRepo(repo);
    const [answer] = JSON.parse(readFileSync(join(sailDir, 'fake', 'harness.json'), 'utf8')).decide;
    // A blank description is a body the port refuses.
    answer.output.actions = [{ kind: 'edit', description: ' ' }];
    seedHarness(sailDir, 'decide', [answer]);
    const { code, stderr } = await runCaptured(RUN, repo.dir, { env: repo.env });
    expect({ code, stderr }).toEqual({ code: EXIT_OK, stderr: '' });

    const ticket = fakeTicket(repo.dir, 'FAKE-2');
    expect(ticket.labels).not.toContain('groom');
    expect(ticket.description).not.toBe(' ');
    expect(lastComment(repo.dir)).toContain('- failed: edit (');
  });
}, 120_000);

test('groom reports, never applies, a relation to its own ticket or to one the intake did not list as open', async () => {
  await withTempRepo(async (repo) => {
    const sailDir = writeGroomRepo(repo);
    const [found] = JSON.parse(readFileSync(join(sailDir, 'fake', 'harness.json'), 'utf8')).duplicates;
    found.output.candidates = [
      { ticketKey: 'FAKE-2', confidence: 0.95, why: 'injected' },
      { ticketKey: 'FAKE-9', confidence: 0.95, why: 'injected' },
    ];
    seedHarness(sailDir, 'duplicates', [found]);
    const [answer] = JSON.parse(readFileSync(join(sailDir, 'fake', 'harness.json'), 'utf8')).decide;
    answer.output.actions = [
      { kind: 'duplicate', of: 'FAKE-2' },
      { kind: 'duplicate', of: 'FAKE-9' },
      { kind: 'related', to: 'FAKE-2' },
      { kind: 'blocks', to: 'FAKE-9' },
    ];
    seedHarness(sailDir, 'decide', [answer]);
    const { code, stderr } = await runCaptured(RUN, repo.dir, { env: repo.env });
    expect({ code, stderr }).toEqual({ code: EXIT_OK, stderr: '' });

    const ticket = fakeTicket(repo.dir, 'FAKE-2');
    expect(ticket.state.type).toBe('unstarted');
    expect(ticket.links).toEqual([]);
    const comment = lastComment(repo.dir);
    for (const line of [
      '- reported, not marked: duplicate of FAKE-2 (this ticket itself)',
      '- reported, not marked: duplicate of FAKE-9 (not an open ticket the intake listed)',
      '- reported, not marked: related FAKE-2 (this ticket itself)',
      '- reported, not marked: blocks FAKE-9 (not an open ticket the intake listed)',
    ]) {
      expect(comment).toContain(line);
    }
    expect(comment).not.toContain('- applied:');
    expect(comment).not.toContain('- failed:');
  });
}, 120_000);

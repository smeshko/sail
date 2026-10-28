// sail's own `groom` workflow, end to end through the CLI on the fakes: `sail FAKE-2 --workflow groom` in a temporary
// repository that holds a copy of the repository's own `.sail/`, its ports all fake (.sail/fake/*.json).
import { expect, test } from 'bun:test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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

test('a groom run on fakes reads FAKE-2 unclaimed, comments the report and swaps groom for open-questions, leaving it in Backlog', async () => {
  await withTempRepo(async (repo) => {
    writeGroomRepo(repo);
    const { code, stderr } = await runCaptured(RUN, repo.dir, { env: repo.env });
    expect({ code, stderr }).toEqual({ code: EXIT_OK, stderr: '' });

    const dir = onlyRun(repo.dir);
    expect(readStatus(dir)).toEqual({ status: 'completed' });
    const keys = readJournal(dir).entries.map((entry) => entry.key);
    expect(keys[0]).toBe('intake#1');
    expect(keys.slice(1, 5).sort()).toEqual(['duplicates#1', 'questions#1', 'staleness#1', 'worth#1']);
    expect(keys.slice(5)).toEqual(['decide#1', 'act#1']);
    const { entry, asked } = duplicatesCall(dir);
    expect(entry.output).toEqual({
      candidates: [{ ticketKey: 'FAKE-1', confidence: 0.6, why: expect.any(String) }],
    });
    expect(
      asked.map((event) => [(event as { key?: string }).key, (event as { questions?: number }).questions]),
    ).toEqual([['duplicates#1', 1]]);

    const ticket = fakeTicket(repo.dir, 'FAKE-2');
    expect(ticket.state).toEqual({ type: 'unstarted', name: 'Backlog' });
    expect(ticket.labels).toEqual(['open-questions']);
    const seeded = ticket.comments.length;
    const comment = ticket.comments.at(-1)?.body ?? '';
    for (const heading of [
      '## Worth',
      '## Merges',
      '## Duplicates',
      '## Staleness',
      '## Labels',
      '## Open questions',
    ]) {
      expect(comment).toContain(heading);
    }
    expect(comment).toContain('## Actions');
    expect(comment).toContain('Labelled `open-questions`.');
    expect(seeded).toBe(2);

    const types = readEvents(dir).map((event) => event.type);
    expect(types).not.toContain('ticket:claimed');
    expect(types).not.toContain('ticket:updated');
    const unlabelled = readEvents(dir).filter((event) => event.type === 'ticket:unlabelled');
    expect(unlabelled.map((event) => (event as { label?: string }).label)).toEqual(['groom']);
    const labelled = readEvents(dir).filter((event) => event.type === 'ticket:labelled');
    expect(labelled.map((event) => (event as { label?: string }).label)).toEqual(['open-questions']);
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
    expect(brief).toContain('<untrusted-input source="ticket FAKE-2, state">');
    expect(brief).toContain('<untrusted-input source="ticket FAKE-2, label 1">');
    expect(brief).not.toContain('State: Backlog');
    expect(others).toContain('<untrusted-input source="ticket FAKE-1, state">');
    expect(others).toContain('<untrusted-input source="ticket FAKE-1, labels">');
    expect(others).toContain('<untrusted-input source="ticket FAKE-1, description">');
    expect(others).toContain('A run with no agent calls prints `total $0.00`');
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

/** Reseeds the fake Jev's answer for FAKE-1, the one question the duplicates stage asks, with `noul`. */
function seedDuplicate(sailDir: string, noul: number): void {
  const path = join(sailDir, 'fake', 'jev.json');
  const seed = JSON.parse(readFileSync(path, 'utf8'));
  seed.answers['FAKE-1'].noul = noul;
  writeFileSync(path, `${JSON.stringify(seed, null, 2)}\n`);
}

/** The duplicates call's journal entry, and the events the run left under its key. */
function duplicatesCall(runDir: string) {
  const entry = readJournal(runDir).entries.find((each) => each.key === 'duplicates#1');
  if (entry === undefined) throw new Error('no duplicates#1 in the journal');
  const asked = readEvents(runDir).filter((event) => event.type === 'jev:asked');
  return { entry, asked };
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
    seedDuplicate(sailDir, 0.1);
    const { code, stderr } = await runCaptured(RUN, repo.dir, { env: repo.env });
    expect({ code, stderr }).toEqual({ code: EXIT_OK, stderr: '' });

    expect(duplicatesCall(onlyRun(repo.dir)).entry.output).toEqual({ candidates: [] });
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

/** Reseeds one check's or the judge's only answer, changed by `change`. */
function reseed(sailDir: string, stage: string, change: (output: Record<string, unknown>) => void): void {
  const [answer] = JSON.parse(readFileSync(join(sailDir, 'fake', 'harness.json'), 'utf8'))[stage];
  change(answer.output);
  seedHarness(sailDir, stage, [answer]);
}

/** The ticket keys of the ticket:labelled or ticket:unlabelled events of the run, with the label. */
const labelEvents = (repoDir: string, type: 'ticket:labelled' | 'ticket:unlabelled') =>
  readEvents(onlyRun(repoDir))
    .filter((event) => event.type === type)
    .map((event) => (event as { label?: string }).label);

test('groom labels a ticket with no open question groomed', async () => {
  await withTempRepo(async (repo) => {
    const sailDir = writeGroomRepo(repo);
    reseed(sailDir, 'decide', (output) => {
      output.questions = [];
    });
    const { code, stderr } = await runCaptured(RUN, repo.dir, { env: repo.env });
    expect({ code, stderr }).toEqual({ code: EXIT_OK, stderr: '' });

    expect(fakeTicket(repo.dir, 'FAKE-2').labels).toEqual(['groomed']);
    expect(lastComment(repo.dir)).toContain('Labelled `groomed`.');
  });
}, 120_000);

test('groom cancels a ticket the worth check gave cancel at the threshold, and labels it groomed despite its questions', async () => {
  await withTempRepo(async (repo) => {
    const sailDir = writeGroomRepo(repo);
    reseed(sailDir, 'worth', (output) => {
      Object.assign(output, { verdict: 'cancel', confidence: 0.8 });
    });
    reseed(sailDir, 'decide', (output) => {
      output.actions = [{ kind: 'cancel', reason: 'a tidy-up nobody would notice' }];
    });
    const { code, stderr } = await runCaptured(RUN, repo.dir, { env: repo.env });
    expect({ code, stderr }).toEqual({ code: EXIT_OK, stderr: '' });

    const ticket = fakeTicket(repo.dir, 'FAKE-2');
    expect(ticket.state).toEqual({ type: 'canceled', name: 'Canceled' });
    expect(ticket.labels).toEqual(['groomed']);
    expect(lastComment(repo.dir)).toContain('- applied: cancel (a tidy-up nobody would notice)');
  });
}, 120_000);

test('groom cancels a stale ticket whatever the worth check gave', async () => {
  await withTempRepo(async (repo) => {
    const sailDir = writeGroomRepo(repo);
    reseed(sailDir, 'staleness', (output) => {
      output.stale = true;
    });
    reseed(sailDir, 'decide', (output) => {
      output.actions = [{ kind: 'cancel', reason: 'stale' }];
    });
    const { code, stderr } = await runCaptured(RUN, repo.dir, { env: repo.env });
    expect({ code, stderr }).toEqual({ code: EXIT_OK, stderr: '' });

    expect(fakeTicket(repo.dir, 'FAKE-2').state.type).toBe('canceled');
  });
}, 120_000);

test('groom reports, never applies, a cancel the checks do not back', async () => {
  await withTempRepo(async (repo) => {
    const sailDir = writeGroomRepo(repo);
    reseed(sailDir, 'decide', (output) => {
      output.actions = [{ kind: 'cancel', reason: 'too small' }];
    });
    const { code, stderr } = await runCaptured(RUN, repo.dir, { env: repo.env });
    expect({ code, stderr }).toEqual({ code: EXIT_OK, stderr: '' });

    expect(fakeTicket(repo.dir, 'FAKE-2').state.type).toBe('unstarted');
    expect(lastComment(repo.dir)).toContain(
      '- reported, not marked: cancel (the worth check gave keep at 0.70, and the ticket is not stale)',
    );
    expect(readEvents(onlyRun(repo.dir)).map((event) => event.type)).not.toContain('ticket:updated');
  });
}, 120_000);

const MERGED = 'Print the total.\n\n## Merged from FAKE-2\n\nShow the cost total.';

test('groom merges the ticket into another the worth check named: the survivor takes the description, the ticket is canceled as its duplicate', async () => {
  await withTempRepo(async (repo) => {
    const sailDir = writeGroomRepo(repo);
    reseed(sailDir, 'worth', (output) => {
      output.merges = [{ ticketKey: 'FAKE-1', confidence: 0.9, why: 'one footer line' }];
    });
    reseed(sailDir, 'decide', (output) => {
      output.actions = [{ kind: 'merge', into: 'FAKE-1', absorb: ['FAKE-2'], description: MERGED }];
    });
    const { code, stderr } = await runCaptured(RUN, repo.dir, { env: repo.env });
    expect({ code, stderr }).toEqual({ code: EXIT_OK, stderr: '' });

    expect(fakeTicket(repo.dir, 'FAKE-1').description).toBe(MERGED);
    const ticket = fakeTicket(repo.dir, 'FAKE-2');
    expect(ticket.state.type).toBe('canceled');
    expect(ticket.links.map((link) => link.title?.split(':')[0])).toEqual(['duplicate FAKE-1']);
    expect(ticket.labels).toEqual(['groomed']);
    expect(lastComment(repo.dir)).toContain('- applied: merge FAKE-2 into FAKE-1');
  });
}, 120_000);

test('groom reports a merge under the threshold, and one that would absorb a started ticket, and changes no ticket', async () => {
  await withTempRepo(async (repo) => {
    const sailDir = writeGroomRepo(repo);
    edit(sailDir, 'fake/tickets.json', '"name": "Todo"', '"name": "In Progress"');
    edit(
      sailDir,
      'fake/tickets.json',
      '"type": "unstarted",\n        "name": "In Progress"',
      '"type": "started",\n        "name": "In Progress"',
    );
    repo.git('commit', '-am', 'FAKE-1 is started');
    reseed(sailDir, 'decide', (output) => {
      output.actions = [
        { kind: 'merge', into: 'FAKE-1', absorb: ['FAKE-2'], description: MERGED },
        { kind: 'merge', into: 'FAKE-2', absorb: ['FAKE-1'], description: MERGED },
      ];
    });
    const { code, stderr } = await runCaptured(RUN, repo.dir, { env: repo.env });
    expect({ code, stderr }).toEqual({ code: EXIT_OK, stderr: '' });

    expect(fakeTicket(repo.dir, 'FAKE-2').state.type).toBe('unstarted');
    expect(fakeTicket(repo.dir, 'FAKE-1').description).not.toBe(MERGED);
    const comment = lastComment(repo.dir);
    expect(comment).toContain(
      '- reported, not marked: merge of FAKE-2 into FAKE-1 (FAKE-1 at confidence 0.60, under 0.80)',
    );
    expect(comment).toContain('- reported, not marked: merge of FAKE-1 into FAKE-2 (FAKE-1 started or an epic)');
  });
}, 120_000);

test("groom sets the ticket's labels: one of each group, taking off the group's others and keeping the rest", async () => {
  await withTempRepo(async (repo) => {
    const sailDir = writeGroomRepo(repo);
    edit(sailDir, 'fake/tickets.json', '"labels": ["groom"]', '"labels": ["groom", "bug", "core", "epic"]');
    repo.git('commit', '-am', 'FAKE-2 carries labels');
    reseed(sailDir, 'decide', (output) => {
      output.actions = [
        { kind: 'labels', set: { type: 'feature', platform: 'cli', source: 'dogfooding' } },
        { kind: 'labels', set: { type: 'bug', platform: 'core' } },
      ];
    });
    const { code, stderr } = await runCaptured(RUN, repo.dir, { env: repo.env });
    expect({ code, stderr }).toEqual({ code: EXIT_OK, stderr: '' });

    expect(fakeTicket(repo.dir, 'FAKE-2').labels.sort()).toEqual(
      ['cli', 'dogfooding', 'epic', 'feature', 'open-questions'].sort(),
    );
    expect(labelEvents(repo.dir, 'ticket:unlabelled').sort()).toEqual(['bug', 'core', 'groom']);
    const comment = lastComment(repo.dir);
    expect(comment).toContain('- applied: labels feature, cli, dogfooding');
    expect(comment).toContain('- reported, not marked: labels (the labels are already set)');
  });
}, 120_000);

test('groom never cancels an epic', async () => {
  await withTempRepo(async (repo) => {
    const sailDir = writeGroomRepo(repo);
    edit(sailDir, 'fake/tickets.json', '"labels": ["groom"]', '"labels": ["groom", "epic"]');
    repo.git('commit', '-am', 'FAKE-2 is an epic');
    reseed(sailDir, 'staleness', (output) => {
      output.stale = true;
    });
    reseed(sailDir, 'decide', (output) => {
      output.actions = [{ kind: 'cancel', reason: 'stale' }];
    });
    const { code, stderr } = await runCaptured(RUN, repo.dir, { env: repo.env });
    expect({ code, stderr }).toEqual({ code: EXIT_OK, stderr: '' });

    expect(fakeTicket(repo.dir, 'FAKE-2').state.type).toBe('unstarted');
    expect(lastComment(repo.dir)).toContain('- reported, not marked: cancel (started or an epic)');
  });
}, 120_000);

test("groom's intake names the sail port command when sail can't start, rather than throwing a TypeError", async () => {
  await withTempRepo(async (repo) => {
    const source = join(repo.home, 'source.json');
    const out = join(repo.home, 'out');
    const empty = join(repo.home, 'no-sail');
    mkdirSync(out);
    mkdirSync(empty);
    writeFileSync(source, JSON.stringify({ ticketKey: 'FAKE-2' }));
    const child = Bun.spawnSync(
      [process.execPath, join(import.meta.dir, '..', '.sail', 'workflows', 'groom', 'read.mjs')],
      {
        env: { ...repo.env, PATH: empty, INPUT_SOURCE: source, STAGE_OUT: out },
      },
    );
    const stderr = child.stderr.toString();
    expect(child.exitCode).not.toBe(0);
    expect(stderr).toContain('sail port ticket-source get FAKE-2: ');
    expect(stderr).not.toContain('TypeError');
  });
});

/** The request the duplicates stage wrote, read from the file the journal records for the call. */
function duplicatesRequest(runDir: string): { state: Record<string, unknown>; questions: Record<string, unknown> } {
  const { entry } = duplicatesCall(runDir);
  return JSON.parse(readFileSync(join(runDir, entry.files['request.json'] as string), 'utf8'));
}

test("groom's duplicates stage leaves the ticket itself out of what it asks Jev", async () => {
  await withTempRepo(async (repo) => {
    const sailDir = writeGroomRepo(repo);
    seedDuplicate(sailDir, 0.1);
    const path = join(sailDir, 'fake', 'jev.json');
    const seed = JSON.parse(readFileSync(path, 'utf8'));
    seed.answers['FAKE-2'] = { type: 'noul', noul: 1 };
    writeFileSync(path, JSON.stringify(seed));
    const { code, stderr } = await runCaptured(RUN, repo.dir, { env: repo.env });
    expect({ code, stderr }).toEqual({ code: EXIT_OK, stderr: '' });

    const dir = onlyRun(repo.dir);
    const request = duplicatesRequest(dir);
    expect(Object.keys(request.questions)).toEqual(['FAKE-1']);
    const state = JSON.stringify(request.state);
    expect(state).toContain('<untrusted-input source=\\"ticket FAKE-1, title\\">');
    expect(state).toContain('<untrusted-input source=\\"ticket FAKE-2, description\\">');
    expect(duplicatesCall(dir).entry.output).toEqual({ candidates: [] });
  });
}, 120_000);

test("groom's duplicates stage asks about and returns a started ticket", async () => {
  await withTempRepo(async (repo) => {
    const sailDir = writeGroomRepo(repo);
    edit(
      sailDir,
      'fake/tickets.json',
      '"type": "unstarted",\n        "name": "Todo"',
      '"type": "started",\n        "name": "In Progress"',
    );
    repo.git('commit', '-am', 'FAKE-1 is started');
    seedDuplicate(sailDir, 0.95);
    const { code, stderr } = await runCaptured(RUN, repo.dir, { env: repo.env });
    expect({ code, stderr }).toEqual({ code: EXIT_OK, stderr: '' });

    const dir = onlyRun(repo.dir);
    expect(Object.keys(duplicatesRequest(dir).questions)).toEqual(['FAKE-1']);
    expect(duplicatesCall(dir).entry.output).toEqual({
      candidates: [{ ticketKey: 'FAKE-1', confidence: 0.95, why: expect.any(String) }],
    });
    expect(duplicatesCall(dir).asked).toHaveLength(1);
  });
}, 120_000);

test("groom's duplicates stage asks Jev nothing when no other ticket is open", async () => {
  await withTempRepo(async (repo) => {
    const sailDir = writeGroomRepo(repo);
    edit(
      sailDir,
      'fake/tickets.json',
      '"type": "unstarted",\n        "name": "Todo"',
      '"type": "completed",\n        "name": "Done"',
    );
    repo.git('commit', '-am', 'FAKE-1 is done');
    const { code, stderr } = await runCaptured(RUN, repo.dir, { env: repo.env });
    expect({ code, stderr }).toEqual({ code: EXIT_OK, stderr: '' });

    const dir = onlyRun(repo.dir);
    const { entry, asked } = duplicatesCall(dir);
    expect(asked).toEqual([]);
    expect(entry.output).toEqual({ candidates: [] });
    expect(readStatus(dir)).toEqual({ status: 'completed' });
  });
}, 120_000);

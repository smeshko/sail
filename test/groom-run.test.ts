// sail's own `groom` workflow, end to end through the CLI on the fakes: `sail FAKE-2 --workflow groom` in a temporary
// repository that holds a copy of the repository's own `.sail/`, its ports all fake (.sail/fake/*.json).
import { expect, test } from 'bun:test';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { createFakeCodeHost } from '../src/adapters/fake/code-host';
import { createFakeTicketSource } from '../src/adapters/fake/ticket-source';
import { EXIT_OK, EXIT_REFUSED, EXIT_SUSPENDED } from '../src/cli/exit-codes';
import { readJournal } from '../src/engine/journal';
import { readStatus } from '../src/engine/run-dir';
import { readEvents } from '../src/events/consumers/ndjson';
import { openWatchTarget, pollOnce } from '../src/watch/poll';
import { edit, seedHarness } from './helpers/fixture';
import { fakeTicket, onlyRun, writeGroomRepo } from './helpers/groom-fixture';
import { runCaptured } from './helpers/run-captured';
import { sail } from './helpers/sail-process';
import { type TempRepo, withTempRepo } from './helpers/temp-repo';

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
    expect(duplicatesCall(dir).output).toEqual({
      candidates: [{ ticketKey: 'FAKE-1', confidence: 0.6, why: expect.any(String) }],
    });

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
      '## Assumptions',
      '## Open questions',
    ]) {
      expect(comment).toContain(heading);
    }
    expect(comment.indexOf('## Open questions')).toBeLessThan(comment.indexOf('## Actions'));
    expect(comment).toContain('1. Should the total include the calls a seeded run reused from the run it came from?');
    expect(comment).toContain('2. Should a run that made no agent calls print a total line at all?');
    expect(comment).toContain("  - include reused: the total is the whole run's cost, as if every call had run here");
    expect(comment).toContain('  - **exclude reused (recommended)**: the total is what this run spent');
    expect(comment).toContain('  - **print $0.00 (recommended)**: every run ends the same way');
    expect(comment.match(/\(recommended\)/g)).toHaveLength(2);
    expect(comment).toContain('  Why: reused calls cost the seeded run nothing');
    expect(comment).toContain('(`src/cli/commands/show.ts:40`)');
    // CommonMark continues a `1. ` item only at three spaces in, and a line after a nested list joins its last bullet
    // unless a blank line parts them: so the options nest under their question and its Why stands apart from them.
    expect(comment).toContain(
      [
        '1. Should the total include the calls a seeded run reused from the run it came from?',
        "   - include reused: the total is the whole run's cost, as if every call had run here",
        "   - **exclude reused (recommended)**: the total is what this run spent, and a seeded run's total is smaller",
        '',
        '   Why: reused calls cost the seeded run nothing, so the total should say what it spent (`src/cli/commands/show.ts:40`)',
        '',
        '2. Should a run that made no agent calls print a total line at all?',
      ].join('\n'),
    );
    expect(comment).toContain('## Actions');
    expect(comment).toContain('Labelled `open-questions`.');
    expect(comment.trimEnd().split('\n').at(-1)).toBe(`sail run ${basename(dir)} groomed this ticket.`);
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

    const call = join(onlyRun(repo.dir), '00-intake', 'call-1', 'out');
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

test('groom wraps every title and description among 150 additional open tickets', async () => {
  await withTempRepo(async (repo) => {
    const sailDir = writeGroomRepo(repo);
    const file = join(sailDir, 'fake', 'tickets.json');
    const seed = JSON.parse(readFileSync(file, 'utf8'));
    for (let n = 100; n < 250; n++)
      seed.tickets.push({
        ...seed.tickets[0],
        ticketKey: `FAKE-${n}`,
        title: `Ticket ${n}`,
        description: `Work ${n}.`,
        labels: [],
        comments: [],
        links: [],
        attachments: [],
      });
    writeFileSync(file, JSON.stringify(seed));
    repo.git('commit', '-am', 'seed many open tickets');
    const { code, stderr } = await runCaptured(RUN, repo.dir, { env: repo.env });
    expect({ code, stderr }).toEqual({ code: EXIT_OK, stderr: '' });
    // Observe real CLI starts when the intake runs over the same large backlog.
    const bin = join(repo.home, 'counted-bin');
    const out = join(repo.home, 'counted-out');
    mkdirSync(bin);
    mkdirSync(out);
    const calls = join(repo.home, 'port-calls');
    const shim = join(bin, 'sail');
    writeFileSync(
      shim,
      `#!/bin/sh\nprintf '%s\\n' "$*" >> '${calls}'\nexec '${process.execPath}' '${join(import.meta.dir, '..', 'src', 'cli', 'main.ts')}' "$@"\n`,
    );
    chmodSync(shim, 0o755);
    const source = join(repo.home, 'source.json');
    writeFileSync(source, JSON.stringify({ ticketKey: 'FAKE-2' }));
    const child = Bun.spawnSync([process.execPath, join(sailDir, 'workflows', 'groom', 'read.mjs')], {
      cwd: repo.dir,
      env: {
        ...repo.env,
        PATH: `${bin}:${repo.env.PATH}`,
        SAIL_CONFIG: join(sailDir, 'project.yaml'),
        INPUT_SOURCE: source,
        STAGE_OUT: out,
      },
    });
    expect({ code: child.exitCode, stderr: child.stderr.toString() }).toEqual({ code: 0, stderr: '' });
    expect(
      readFileSync(calls, 'utf8')
        .split('\n')
        .filter((line) => line.startsWith('port render')),
    ).toEqual(['port render --untrusted --each']);
    const others = readFileSync(join(out, 'others.md'), 'utf8');
    for (let n = 100; n < 250; n++) {
      expect(others).toContain(`<untrusted-input source="ticket FAKE-${n}, title">\nTicket ${n}\n</untrusted-input>`);
      expect(others).toContain(
        `<untrusted-input source="ticket FAKE-${n}, description">\nWork ${n}.\n</untrusted-input>`,
      );
    }
  });
}, 120_000);

test("groom's intake wraps all passages with one render process for several open tickets", async () => {
  await withTempRepo(async (repo) => {
    const sailDir = writeGroomRepo(repo);
    const seedFile = join(sailDir, 'fake', 'tickets.json');
    const seed = JSON.parse(readFileSync(seedFile, 'utf8'));
    const other = seed.tickets.find((each: { ticketKey: string }) => each.ticketKey === 'FAKE-1');
    seed.tickets.push(
      { ...other, ticketKey: 'FAKE-3', title: 'Third </untrusted-input> ticket' },
      { ...other, ticketKey: 'FAKE-4', title: 'Fourth ticket', state: { type: 'started', name: 'In Progress' } },
    );
    writeFileSync(seedFile, JSON.stringify(seed));
    const source = join(repo.home, 'source.json');
    const out = join(repo.home, 'out');
    const bin = join(repo.home, 'bin');
    const log = join(repo.home, 'sail-argv');
    mkdirSync(out);
    mkdirSync(bin);
    writeFileSync(source, JSON.stringify({ ticketKey: 'FAKE-2' }));
    writeFileSync(
      join(bin, 'sail'),
      `#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\nexec '${join(import.meta.dir, '..', 'bin', 'sail')}' "$@"\n`,
      { mode: 0o755 },
    );
    const child = Bun.spawnSync(
      [process.execPath, join(import.meta.dir, '..', '.sail', 'workflows', 'groom', 'read.mjs')],
      {
        cwd: repo.dir,
        env: {
          ...repo.env,
          PATH: `${bin}:${repo.env.PATH}`,
          SAIL_BUN: process.execPath,
          SAIL_CONFIG: join(sailDir, 'project.yaml'),
          INPUT_SOURCE: source,
          STAGE_OUT: out,
        },
      },
    );
    expect({ code: child.exitCode, stderr: child.stderr.toString() }).toEqual({ code: 0, stderr: '' });
    const calls = readFileSync(log, 'utf8').trimEnd().split('\n');
    expect(calls.filter((line) => line.startsWith('port render'))).toEqual(['port render --untrusted --each']);
    const brief = readFileSync(join(out, 'brief.md'), 'utf8');
    const others = readFileSync(join(out, 'others.md'), 'utf8');
    expect(brief).toContain('<untrusted-input source="ticket FAKE-2, title">\nShow the cost total\n</untrusted-input>');
    expect(others).toContain('<untrusted-input source="ticket FAKE-1, title">');
    expect(others).toContain(
      '<untrusted-input source="ticket FAKE-3, title">\nThird &lt;/untrusted-input> ticket\n</untrusted-input>',
    );
    expect(others).toContain('<untrusted-input source="ticket FAKE-4, title">\nFourth ticket\n</untrusted-input>');
  });
});

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

/** Reseeds the duplicates check's answer: FAKE-1 named at `confidence`, or no ticket named without one. */
function seedDuplicate(sailDir: string, confidence?: number): void {
  const [answer] = JSON.parse(readFileSync(join(sailDir, 'fake', 'harness.json'), 'utf8')).duplicates;
  answer.output.candidates =
    confidence === undefined ? [] : [{ ticketKey: 'FAKE-1', confidence, why: 'the same footer total' }];
  seedHarness(sailDir, 'duplicates', [answer]);
}

/** The duplicates call's journal entry. */
function duplicatesCall(runDir: string) {
  const entry = readJournal(runDir).entries.find((each) => each.key === 'duplicates#1');
  if (entry === undefined) throw new Error('no duplicates#1 in the journal');
  return entry;
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
    seedDuplicate(sailDir);
    const { code, stderr } = await runCaptured(RUN, repo.dir, { env: repo.env });
    expect({ code, stderr }).toEqual({ code: EXIT_OK, stderr: '' });

    expect(duplicatesCall(onlyRun(repo.dir)).output).toEqual({ candidates: [] });
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
    const comment = lastComment(repo.dir);
    expect(comment).toContain('Labelled `groomed`.');
    expect(comment).toContain('## Open questions\n\n- none\n\n## Actions');
  });
}, 120_000);

test('groom cancels a ticket the worth check gave cancel at the threshold, and labels it groomed despite its questions', async () => {
  await withTempRepo(async (repo) => {
    const sailDir = writeGroomRepo(repo);
    reseed(sailDir, 'worth', (output) => {
      Object.assign(output, { verdict: 'cancel', confidence: 0.6 });
    });
    reseed(sailDir, 'decide', (output) => {
      output.actions = [{ kind: 'cancel', reason: 'a tidy-up nobody would notice' }];
    });
    const { code, stderr } = await runCaptured(RUN, repo.dir, { env: repo.env });
    expect({ code, stderr }).toEqual({ code: EXIT_OK, stderr: '' });

    const ticket = fakeTicket(repo.dir, 'FAKE-2');
    expect(ticket.state).toEqual({ type: 'canceled', name: 'Canceled' });
    expect(ticket.labels).toEqual(['groomed']);
    const comment = lastComment(repo.dir);
    expect(comment).toContain('- applied: cancel (a tidy-up nobody would notice)');
    expect(comment).toContain('## Open questions\n\n- none\n\n## Actions');
    expect(comment).not.toContain('(recommended)');
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
      '- reported, not marked: cancel (the worth check gave keep at 0.70, at or over 0.60, and the ticket is not stale)',
    );
    expect(readEvents(onlyRun(repo.dir)).map((event) => event.type)).not.toContain('ticket:updated');
  });
}, 120_000);

/** Runs groom with the worth check at `verdict` and `confidence`, FAKE-2 labelled `code-review` when `fromReview`. */
async function cancelWith(repo: TempRepo, verdict: string, confidence: number, fromReview = false) {
  const sailDir = writeGroomRepo(repo);
  if (fromReview) edit(sailDir, 'fake/tickets.json', '"labels": ["groom"]', '"labels": ["groom", "code-review"]');
  reseed(sailDir, 'worth', (output) => {
    Object.assign(output, { verdict, confidence });
  });
  reseed(sailDir, 'decide', (output) => {
    output.actions = [{ kind: 'cancel', reason: 'no case for it' }];
  });
  const { code, stderr } = await runCaptured(RUN, repo.dir, { env: repo.env });
  expect({ code, stderr }).toEqual({ code: EXIT_OK, stderr: '' });
  return fakeTicket(repo.dir, 'FAKE-2').state.type;
}

test.each([
  ['a cancel at 0.59', 'cancel', 0.59, false, 'unstarted'],
  ['a keep under 0.60', 'keep', 0.59, false, 'canceled'],
  ['a keep at 0.60', 'keep', 0.6, false, 'unstarted'],
  ['a cancel at 0.50 on a code-review ticket', 'cancel', 0.5, true, 'canceled'],
  ['a cancel at 0.49 on a code-review ticket', 'cancel', 0.49, true, 'unstarted'],
  ['a keep at 0.69 on a code-review ticket', 'keep', 0.69, true, 'canceled'],
  ['a keep at 0.70 on a code-review ticket', 'keep', 0.7, true, 'unstarted'],
])(
  'with the worth check giving %s, the judge asking for a cancel leaves FAKE-2 %s',
  async (_name, verdict, confidence, fromReview, state) => {
    await withTempRepo(async (repo) => {
      expect<string>(await cancelWith(repo, verdict as string, confidence as number, fromReview as boolean)).toBe(
        state as string,
      );
    });
  },
  120_000,
);

const MERGED = 'Print the total.\n\n## Merged from FAKE-2\n\nShow the cost total.';

test.each([
  ['the worth check names FAKE-1 at 0.65', 0.65, 0.6, 'canceled'],
  ['the duplicates check alone names FAKE-1 at 0.79', 0.3, 0.79, 'unstarted'],
  ['the duplicates check alone names FAKE-1 at 0.80', 0.3, 0.8, 'canceled'],
])(
  'when %s, a merge of FAKE-2 into FAKE-1 leaves FAKE-2 %s',
  async (_name, worth, duplicate, state) => {
    await withTempRepo(async (repo) => {
      const sailDir = writeGroomRepo(repo);
      seedDuplicate(sailDir, duplicate as number);
      reseed(sailDir, 'worth', (output) => {
        output.merges = [{ ticketKey: 'FAKE-1', confidence: worth, why: 'one footer line' }];
      });
      reseed(sailDir, 'decide', (output) => {
        output.actions = [{ kind: 'merge', into: 'FAKE-1', absorb: ['FAKE-2'], description: MERGED }];
      });
      const { code, stderr } = await runCaptured(RUN, repo.dir, { env: repo.env });
      expect({ code, stderr }).toEqual({ code: EXIT_OK, stderr: '' });
      expect<string>(fakeTicket(repo.dir, 'FAKE-2').state.type).toBe(state as string);
    });
  },
  120_000,
);

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
      '- reported, not marked: merge of FAKE-2 into FAKE-1 (FAKE-1 at worth 0.60, under 0.65; duplicates 0.60, under 0.80)',
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

test("groom's duplicates check searches a started ticket among the others", async () => {
  await withTempRepo(async (repo) => {
    const sailDir = writeGroomRepo(repo);
    edit(
      sailDir,
      'fake/tickets.json',
      '"type": "unstarted",\n        "name": "Todo"',
      '"type": "started",\n        "name": "In Progress"',
    );
    repo.git('commit', '-am', 'FAKE-1 is started');
    const { code, stderr } = await runCaptured(RUN, repo.dir, { env: repo.env });
    expect({ code, stderr }).toEqual({ code: EXIT_OK, stderr: '' });

    const call = join(onlyRun(repo.dir), '01-duplicates', 'call-1');
    const others = readFileSync(join(call, 'in', 'others.md'), 'utf8');
    expect(others).toContain('## FAKE-1');
    expect(others).toContain('In Progress');
    expect(readFileSync(join(call, 'prompt.md'), 'utf8')).toContain(join(call, 'in', 'others.md'));
  });
}, 120_000);

/** Scripts FAKE-2's label answers in the committed seed. */
function scriptLabels(repo: TempRepo, answers: Record<string, string[]>): void {
  const tickets = join(repo.dir, '.sail', 'fake', 'tickets.json');
  const world = JSON.parse(readFileSync(tickets, 'utf8'));
  world.tickets.find((each: { ticketKey: string }) => each.ticketKey === 'FAKE-2').answers = answers;
  writeFileSync(tickets, JSON.stringify(world));
  repo.git('add', '.sail/fake/tickets.json');
  repo.git('commit', '-q', '-m', 'script the label answers');
}

const reports = (repoDir: string) =>
  fakeTicket(repoDir, 'FAKE-2').comments.filter((each) => each.body.includes('## Actions'));

test('a remove-label the provider refuses once is tried again, so the run completes with one report and open-questions alone', async () => {
  await withTempRepo(async (repo) => {
    writeGroomRepo(repo);
    scriptLabels(repo, { removeLabel: ['unavailable', 'ok'] });
    const { code, stderr } = await runCaptured(RUN, repo.dir, { env: repo.env });
    expect({ code, stderr }).toEqual({ code: EXIT_OK, stderr: '' });
    expect(readStatus(onlyRun(repo.dir))).toEqual({ status: 'completed' });
    const ticket = fakeTicket(repo.dir, 'FAKE-2');
    expect(ticket.labels).toEqual(['open-questions']);
    expect(ticket.comments).toHaveLength(2);
    expect(reports(repo.dir)).toHaveLength(1);
  });
}, 120_000);

test('a groom run suspended after its report posts no second report on resume, and finishes the label swap', async () => {
  await withTempRepo(async (repo) => {
    writeGroomRepo(repo);
    scriptLabels(repo, { removeLabel: ['unavailable', 'unavailable', 'unavailable', 'ok'] });
    const first = await sail(repo.dir, repo.env, RUN);
    expect(first.code).toBe(EXIT_SUSPENDED);
    const dir = onlyRun(repo.dir);
    const runId = basename(dir);
    expect(readStatus(dir)).toMatchObject({ status: 'suspended', stopReason: 'port_unavailable' });

    const ticket = fakeTicket(repo.dir, 'FAKE-2');
    expect(ticket.labels).toContain('groom');
    expect(reports(repo.dir)).toHaveLength(1);
    expect(reports(repo.dir)[0]?.body.trimEnd().split('\n').at(-1)).toBe(`sail run ${runId} groomed this ticket.`);

    const resumed = await sail(repo.dir, repo.env, ['resume', runId]);
    expect(resumed.code).toBe(EXIT_OK);
    expect(readStatus(dir)).toEqual({ status: 'completed' });
    const after = fakeTicket(repo.dir, 'FAKE-2');
    expect(after.labels).toEqual(['open-questions']);
    expect(after.comments).toHaveLength(2);
    expect(reports(repo.dir)).toHaveLength(1);
  });
}, 120_000);

const question = (ask: string) => ({
  ask,
  options: [
    { option: 'include', means: 'the total counts every call, reused ones too' },
    { option: 'exclude', means: 'the total counts only the calls this run made' },
  ],
  recommend: 'exclude',
  why: 'summary.json marks reused calls apart from the run its own calls',
  cites: ['src/cli/commands/show.ts:40'],
});

/** The `output:invalid` events of the run for `key`. */
const invalidFor = (repoDir: string, key: string) =>
  readEvents(onlyRun(repoDir)).filter((event) => event.type === 'output:invalid' && event.key === key);

test('a malformed question gets a corrective try', async () => {
  await withTempRepo(async (repo) => {
    const sailDir = writeGroomRepo(repo);
    const [answer] = JSON.parse(readFileSync(join(sailDir, 'fake', 'harness.json'), 'utf8')).questions;
    const malformed = {
      ...answer,
      output: {
        questions: [{ ...question('Count reused calls'), options: [{ option: 'include', means: 'all' }], cites: [] }],
      },
    };
    const valid = { ...answer, output: { questions: [question('Count reused calls?')] } };
    seedHarness(sailDir, 'questions', [malformed, valid]);
    const { code, stderr } = await runCaptured(RUN, repo.dir, { env: repo.env });
    expect({ code, stderr }).toEqual({ code: EXIT_OK, stderr: '' });

    expect(invalidFor(repo.dir, 'questions#1')).toHaveLength(1);
    const entry = readJournal(onlyRun(repo.dir)).entries.find((each) => each.key === 'questions#1');
    expect(entry?.output).toEqual({ questions: [question('Count reused calls?')] });
  });
}, 120_000);

test('a question whose recommendation is not among its options gets a corrective try', async () => {
  await withTempRepo(async (repo) => {
    const sailDir = writeGroomRepo(repo);
    const [answer] = JSON.parse(readFileSync(join(sailDir, 'fake', 'harness.json'), 'utf8')).questions;
    const wrong = { ...answer, output: { questions: [{ ...question('Count reused calls?'), recommend: 'neither' }] } };
    const valid = { ...answer, output: { questions: [question('Count reused calls?')] } };
    seedHarness(sailDir, 'questions', [wrong, valid]);
    const { code } = await runCaptured(RUN, repo.dir, { env: repo.env });
    expect(code).toBe(EXIT_OK);
    expect(invalidFor(repo.dir, 'questions#1')).toHaveLength(1);
  });
}, 120_000);

test('a decision with three questions gets a corrective try', async () => {
  await withTempRepo(async (repo) => {
    const sailDir = writeGroomRepo(repo);
    const [answer] = JSON.parse(readFileSync(join(sailDir, 'fake', 'harness.json'), 'utf8')).decide;
    const three = {
      ...answer,
      output: { ...answer.output, questions: ['A?', 'B?', 'C?'].map((ask) => question(ask)) },
    };
    const two = { ...answer, output: { ...answer.output, questions: ['A?', 'B?'].map((ask) => question(ask)) } };
    seedHarness(sailDir, 'decide', [three, two]);
    const { code, stderr } = await runCaptured(RUN, repo.dir, { env: repo.env });
    expect({ code, stderr }).toEqual({ code: EXIT_OK, stderr: '' });

    expect(invalidFor(repo.dir, 'decide#1')).toHaveLength(1);
    const entry = readJournal(onlyRun(repo.dir)).entries.find((each) => each.key === 'decide#1');
    expect((entry?.output as { questions: unknown[] } | undefined)?.questions).toHaveLength(2);
  });
}, 120_000);

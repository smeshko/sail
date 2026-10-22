// The fixture repository's `land`, end to end through the CLI on the fakes: `sail FAKE-1 --workflow land` in a
// temporary repository that holds a copy of the fixture's `.sail/`. Its five script steps reach the ports only through
// `sail port`, in real child processes: publish opens pull request 5, hand-over moves the ticket to in review, checks
// reads the pull request's checks, relabel swaps sail for sail-landed, and merge merges it at the head publish opened it
// with. The fake code host's `opened` scripts what a pull request opened during the run answers. `land` is kept beside the
// fixture, in test/fixtures/land/, and added to each copy.
import { expect, test } from 'bun:test';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { EXIT_FAILED, EXIT_OK } from '../../src/cli/exit-codes';
import { validateRunDir } from '../../src/engine/schemas';
import { readEvents } from '../../src/events/consumers/ndjson';
import type { SailEvent } from '../../src/events/types';
import { journaled } from '../helpers/agent-fixture';
import { addLand, copyFixture } from '../helpers/fixture';
import { runCaptured } from '../helpers/run-captured';
import { withTempRepo } from '../helpers/temp-repo';

interface Landed {
  code: number;
  stderr: string;
  events: SailEvent[];
  /** The journal's lines as `<key> <outcome>`. */
  journal: string[];
  /** The output merge#1 recorded, or null when it recorded none. */
  merge: unknown;
  /** Every way the run directory breaks its schemas. */
  issues: unknown[];
}

const json = (...path: string[]) => JSON.parse(readFileSync(join(...path), 'utf8'));

/** `sail FAKE-1 --workflow land` in a copy of the fixture, its fake code host's `opened` set when one is given. */
async function land(opened?: unknown): Promise<Landed> {
  return withTempRepo(async (repo) => {
    const sail = addLand(copyFixture(repo.dir));
    if (opened !== undefined) {
      const seed = join(sail, 'fake', 'prs.json');
      writeFileSync(seed, JSON.stringify({ ...JSON.parse(readFileSync(seed, 'utf8')), opened }, null, 2));
    }
    const { code, stderr } = await runCaptured(['FAKE-1', '--workflow', 'land'], repo.dir, { env: repo.env });
    const runs = join(repo.dir, '.sail-runs');
    const [id] = existsSync(runs) ? readdirSync(runs).filter((name) => name !== 'fake') : [];
    const dir = id === undefined ? '' : join(runs, id);
    return {
      code,
      stderr,
      events: dir === '' ? [] : readEvents(dir),
      journal: dir === '' ? [] : journaled(dir),
      merge: existsSync(join(dir, '05-merge', 'call-1', 'result.json'))
        ? json(dir, '05-merge', 'call-1', 'result.json').output
        : null,
      issues: dir === '' ? ['no run directory'] : validateRunDir(dir).issues,
    };
  });
}

/** What the steps did on the ports, in order: each provider event and error:port under its step's key, in brief. */
function ported(events: readonly SailEvent[]): string[] {
  return events.flatMap((event) => {
    const key = 'key' in event ? event.key : undefined;
    if (key === undefined || key.startsWith('intake#')) return [];
    const e = event as Record<string, unknown>;
    if (event.type === 'codehost:labelled') return [`${key} ${event.type} ${e.label} ${e.change}`];
    if (event.type === 'ticket:updated') return [`${key} ${event.type} ${(e.change as { state: string }).state}`];
    if (event.type === 'codehost:merged') return [`${key} ${event.type} ${e.method} ${e.sha}`];
    if (event.type === 'error:port') return [`${key} ${event.type} ${e.code}: ${e.message}`];
    return event.type.startsWith('ticket:') || event.type.startsWith('codehost:') ? [`${key} ${event.type}`] : [];
  });
}

/** The sha the fake merges pull request `number` at `headSha` with. */
const fakeMergeSha = (number: number, headSha: string) =>
  new Bun.CryptoHasher('sha1').update(`merge #${number}\n${headSha}`).digest('hex');

// biome-ignore format: TDD-PENDING TASK-008
test
  .skip // TDD-PENDING TASK-008
  ('land opens pull request 5, hands FAKE-1 over for review, reads its checks, swaps sail for sail-landed and merges it at the head it opened, each step through sail port, every event valid', async () => {
  const run = await land();
  expect({ code: run.code, stderr: run.stderr }).toEqual({ code: EXIT_OK, stderr: '' });
  const pushed = run.events.find((event) => event.type === 'codehost:pushed') as { headSha: string } | undefined;
  const headSha = pushed?.headSha ?? '';
  expect({
    journal: run.journal,
    ported: ported(run.events),
    merge: run.merge,
    issues: run.issues,
  }).toEqual({
    journal: [
      'intake#1 passed',
      'publish#1 passed',
      'hand-over#1 passed',
      'checks#1 passed',
      'relabel#1 passed',
      'merge#1 passed',
    ],
    ported: [
      'publish#1 codehost:pushed',
      'publish#1 codehost:pr_opened',
      'publish#1 codehost:labelled sail added',
      'hand-over#1 ticket:updated in-review',
      'hand-over#1 ticket:commented',
      'checks#1 codehost:checks',
      'relabel#1 codehost:labelled sail removed',
      'relabel#1 codehost:labelled sail-landed added',
      `merge#1 codehost:merged squash ${fakeMergeSha(5, headSha)}`,
    ],
    merge: { state: 'merged', sha: fakeMergeSha(5, headSha) },
    issues: [],
  });
});

// biome-ignore format: TDD-PENDING TASK-008
test
  .skip // TDD-PENDING TASK-008
  ('a merge the fake code host rejects fails the run with stage_error at merge#1, leaves an error:port with its message there, and records no codehost:merged', async () => {
  const run = await land({ merges: ['rejected'] });
  const end = run.events.at(-1) as Record<string, unknown> | undefined;
  expect({
    code: run.code,
    end: [end?.type, end?.status, end?.stopReason],
    journal: run.journal.at(-1),
    ported: ported(run.events).filter((line) => line.startsWith('merge#1')),
    merged: run.events.filter((event) => event.type === 'codehost:merged'),
  }).toEqual({
    code: EXIT_FAILED,
    end: ['run:end', 'failed', 'stage_error'],
    journal: 'merge#1 error',
    ported: ['merge#1 error:port conflict: codeHost.merge: fake: merge rejected (scripted)'],
    merged: [],
  });
});

// biome-ignore format: TDD-PENDING TASK-008
test
  .skip // TDD-PENDING TASK-008
  ('a failed check fails the run with the reason checks failed, and merge never runs', async () => {
  const run = await land({ checks: [{ name: 'ci', statuses: ['failed'] }] });
  const end = run.events.at(-1) as Record<string, unknown> | undefined;
  expect({
    code: run.code,
    end: [end?.type, end?.status, end?.stopReason, end?.message],
    journal: run.journal,
  }).toEqual({
    code: EXIT_FAILED,
    end: ['run:end', 'failed', 'workflow_failed', 'checks failed'],
    journal: ['intake#1 passed', 'publish#1 passed', 'hand-over#1 passed', 'checks#1 passed'],
  });
});

test('sail check type-checks the fixture with land added, and lists its five private script stages', async () => {
  await withTempRepo(async (repo) => {
    addLand(copyFixture(repo.dir));
    const { code, stdout, stderr } = await runCaptured(['check', '--list'], repo.dir, { env: repo.env });
    expect({ code, stderr, head: stdout.split('\n').slice(0, 10) }).toEqual({
      code: EXIT_OK,
      stderr: '',
      head: [
        '.sail/ checked: 2 workflows, 11 stages',
        '',
        'workflows',
        '  land          intake ticket  .sail/workflows/land/workflow.ts',
        '    private',
        '      checks       script',
        '      hand-over    script',
        '      merge        script',
        '      publish      script',
        '      relabel      script',
      ],
    });
  });
});

// The fixture repository's `review`, end to end through the CLI on the fakes: `sail FAKE-1 --workflow review` in a
// temporary repository that holds a copy of the fixture's `.sail/`. Its six reviewers run in one `run.all()`, each on the
// fake harness after the delay `.sail/fake/harness.json` gives it: the first declared is the slowest.
//
// A run killed mid-group is killed alone: the fake harness runs inside `sail`, so no step process group is involved.
// Each resume runs in a process that has not imported the copy's workflow yet.
import { expect, test } from 'bun:test';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { EXIT_FAILED, EXIT_OK } from '../src/cli/exit-codes';
import { readJournal } from '../src/engine/journal';
import { readStatus } from '../src/engine/run-dir';
import { formatIssue, validateDocument } from '../src/engine/schemas';
import { readEvents } from '../src/events/consumers/ndjson';
import type { Summary } from '../src/events/summary';
import type { SailEvent } from '../src/events/types';
import {
  failReviewer,
  REVIEW_DELAYS,
  REVIEW_KEYS,
  REVIEWER_ERROR,
  REVIEWERS,
  setReviewerDelays,
  swapReviewers,
  waitForJournaled,
  writeReviewFixture,
} from './helpers/review-fixture';
import { runCaptured } from './helpers/run-captured';
import { killOne, sailProcess, until } from './helpers/sail-process';
import { type TempRepo, withTempRepo } from './helpers/temp-repo';

const RUN = ['FAKE-1', '--workflow', 'review'];

/** The directory of the repository's only run, or '' while it has none. */
function onlyRun(repoDir: string): string {
  const runs = join(repoDir, '.sail-runs');
  const ids = existsSync(runs) ? readdirSync(runs).filter((name) => name !== 'fake') : [];
  return ids.length === 1 ? join(runs, ids[0] as string) : '';
}

const keysOf = (dir: string) => readJournal(dir).entries.map((entry) => entry.key);
const ofType = <T extends SailEvent['type']>(list: readonly SailEvent[], type: T) =>
  list.filter((event): event is Extract<SailEvent, { type: T }> => event.type === type);
const isReviewer = (event: SailEvent) => REVIEW_KEYS.includes((event as { key?: string }).key ?? '');

/** `sail FAKE-1 --workflow review` in `repo`, in this process: its exit code and its run's directory. */
async function review(repo: TempRepo): Promise<{ code: number; stderr: string; dir: string }> {
  const { code, stderr } = await runCaptured(RUN, repo.dir, { env: repo.env });
  return { code, stderr, dir: onlyRun(repo.dir) };
}

/**
 * Starts the review as a process of its own, waits until its journal holds `lines` lines, then kills that process
 * alone, and answers with the run's directory.
 */
async function killedAt(repo: TempRepo, lines: number): Promise<string> {
  const child = sailProcess(repo.dir, repo.env, RUN);
  expect(await until('the run directory', () => onlyRun(repo.dir) !== '')).toBe('the run directory');
  const dir = onlyRun(repo.dir);
  expect(await waitForJournaled(dir, lines)).toBe(true);
  killOne(child.pid, 'SIGKILL');
  await child.exited;
  return dir;
}

test('six reviewers with staggered delays run at once: every one starts before the first ends, the group takes well under the sum of their delays, the journal holds them as they completed, and the workflow gets them in the order declared', async () => {
  await withTempRepo(async (repo) => {
    writeReviewFixture(repo.dir);
    const { code, stderr, dir } = await review(repo);
    expect({ code, stderr }).toEqual({ code: EXIT_OK, stderr: '' });

    const events = readEvents(dir);
    const starts = events.flatMap((event, i) => (event.type === 'stage:start' && isReviewer(event) ? [i] : []));
    const firstEnd = events.findIndex((event) => event.type === 'stage:end' && isReviewer(event));
    expect({ starts: starts.length, before: starts.every((i) => i < firstEnd) }).toEqual({ starts: 6, before: true });
    const [ended] = ofType(events, 'all:end');
    const sum = REVIEW_DELAYS.reduce((total, ms) => total + ms, 0);
    expect(ended?.durationMs).toBeLessThan(sum * 0.6);
    expect(keysOf(dir)).toEqual(['intake#1', ...[...REVIEW_KEYS].reverse()]);
    const harness = JSON.parse(readFileSync(join(repo.dir, '.sail', 'fake', 'harness.json'), 'utf8'));
    const summaries = REVIEWERS.map((name) => harness[name][0].output.summary);
    expect(ofType(events, 'run:end')[0]?.result).toEqual({ summaries });
  });
}, 60_000);

test("a review's events all validate against sail.event.v1, its all:start and all:end included, and its summary.json validates and lists one group of the six keys in the order declared", async () => {
  await withTempRepo(async (repo) => {
    writeReviewFixture(repo.dir);
    const { code, dir } = await review(repo);
    expect(code).toBe(EXIT_OK);

    const events = readEvents(dir);
    expect(events.flatMap((event) => validateDocument('sail.event.v1', event)).map(formatIssue)).toEqual([]);
    expect(ofType(events, 'all:start').map((event) => [event.keys, event.running])).toEqual([
      [REVIEW_KEYS, REVIEW_KEYS],
    ]);
    expect(ofType(events, 'all:end').map((event) => event.keys)).toEqual([REVIEW_KEYS]);
    const summary: Summary = JSON.parse(readFileSync(join(dir, 'summary.json'), 'utf8'));
    expect(validateDocument('sail.summary.v1', summary).map(formatIssue)).toEqual([]);
    expect(summary.groups).toEqual([{ keys: REVIEW_KEYS, durationMs: ofType(events, 'all:end')[0]?.durationMs ?? -1 }]);
  });
}, 60_000);

test('a review killed once three reviewers finished resumes with sail resume, which runs only the other three: the journal holds each call once', async () => {
  await withTempRepo(async (repo) => {
    writeReviewFixture(repo.dir);
    setReviewerDelays(repo.dir, {
      style: 50,
      architecture: 100,
      'side-effects': 150,
      performance: 20_000,
      security: 20_000,
      coverage: 20_000,
    });
    const dir = await killedAt(repo, 4);
    expect(keysOf(dir)).toEqual(['intake#1', 'style#1', 'architecture#1', 'side-effects#1']);
    const before = readEvents(dir).length;

    setReviewerDelays(repo.dir, { performance: 50, security: 50, coverage: 50 });
    const resumed = await runCaptured(['resume', dir.split('/').at(-1) as string], repo.dir, { env: repo.env });
    expect({ code: resumed.code, stderr: resumed.stderr }).toEqual({ code: EXIT_OK, stderr: '' });

    const events = readEvents(dir).slice(before);
    const rest = ['performance#1', 'security#1', 'coverage#1'];
    expect(ofType(events, 'stage:start').map((event) => event.key)).toEqual(rest);
    expect(ofType(events, 'all:start').map((event) => event.running)).toEqual([rest]);
    expect(keysOf(dir).sort()).toEqual(['intake#1', ...REVIEW_KEYS].sort());
    expect(readStatus(dir)).toEqual({ status: 'completed' });
  });
}, 120_000);

test('a review killed mid-group whose reviewers were reordered since fails its resume with determinism_violation, naming both key lists', async () => {
  await withTempRepo(async (repo) => {
    const sail = writeReviewFixture(repo.dir);
    setReviewerDelays(repo.dir, { style: 20_000 });
    const dir = await killedAt(repo, 6);
    expect(keysOf(dir)).not.toContain('style#1');

    swapReviewers(sail);
    const resumed = await runCaptured(['resume', dir.split('/').at(-1) as string], repo.dir, { env: repo.env });
    expect(resumed.code).toBe(EXIT_FAILED);
    expect(readStatus(dir)).toEqual({ status: 'failed', stopReason: 'determinism_violation' });
    const swapped = ['architecture#1', 'style#1', ...REVIEW_KEYS.slice(2)];
    expect(ofType(readEvents(dir), 'run:end').at(-1)?.message).toBe(
      `the workflow asked for the group [${swapped.join(', ')}] where the journal has the group [${REVIEW_KEYS.join(', ')}]`,
    );
    expect(keysOf(dir)).toHaveLength(6);
  });
}, 120_000);

test('one reviewer ending in error lets the other five finish, then fails the run with stage_error', async () => {
  await withTempRepo(async (repo) => {
    writeReviewFixture(repo.dir);
    failReviewer(repo.dir, 'security');
    const { code, dir } = await review(repo);
    expect(code).toBe(EXIT_FAILED);
    expect(
      readJournal(dir)
        .entries.map((entry) => `${entry.key} ${entry.outcome}`)
        .sort(),
    ).toEqual(
      [...REVIEW_KEYS.map((key) => `${key} ${key === 'security#1' ? 'error' : 'done'}`), 'intake#1 passed'].sort(),
    );
    expect(readStatus(dir)).toEqual({ status: 'failed', stopReason: 'stage_error' });
    expect(ofType(readEvents(dir), 'run:end').at(-1)?.message).toBe(
      `security#1 ended in error: harness: ${REVIEWER_ERROR}`,
    );
  });
}, 60_000);

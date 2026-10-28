// The chain fixture's `pr-to-main`, by hand: `sail '#7' --workflow pr-to-main` in a clone of the fixture
// (`test/fixtures/chain/.sail/`) on every real adapter but the harness, over the scripted GitHub and Linear worlds. Each
// run is a `sail` process of its own, so the merge's answer is injected into the world before it is served.
//
// The merge step re-reads the pull request when the merge's answer is `pending` or the call failed, such as a lost PUT
// response. A pull request that merged anyway is reported `merged`, so the run goes on to `done` and completes instead
// of handing back a merged pull request with `sail-blocked`. A pull request that did not merge is handed back as before.
import { expect, test } from 'bun:test';
import { EXIT_FAILED, EXIT_OK } from '../../src/cli/exit-codes';
import { type Observed, observe } from '../helpers/chain';
import { type WorldResponse, worldMergeSha } from '../helpers/github-world';
import { ended, labelBodies, merges, outputOf } from '../helpers/pr-to-main';

const answered = (response: WorldResponse): Promise<Observed> =>
  observe(
    {
      pulls: [{ number: 7, branch: 'sail/ADW-1-chain', ticket: 'ADW-1' }],
      github: (world) => world.inject('PUT /pulls/7/merge', response),
    },
    ['#7', '--workflow', 'pr-to-main'],
  );

const PENDING = { status: 200, body: { merged: false, message: 'Merge pending' } };
const LOST = { status: 502, body: { message: 'Bad Gateway' } };

function expectRecovered(run: Observed, outcome: string, reason: string): void {
  const head = outputOf<{ headSha: string }>(run, 'gate#1').headSha;
  expect({ code: run.code, status: run.end.status, issues: run.issues }).toEqual({
    code: EXIT_OK,
    status: 'completed',
    issues: [],
  });
  expect(run.results['merge#1']?.outcome).toBe(outcome);
  expect(outputOf<unknown>(run, 'merge#1')).toEqual({ state: 'merged', sha: worldMergeSha(7, head), reason });
  expect(ended(run)).toContain('done#1');
  expect(run.pulls.find((each) => each.number === 7)?.mergedAt).not.toBeNull();
  expect(labelBodies(run, 7)).toEqual([]);
  expect(run.tickets[1]?.state).toBe('Done');
  expect(merges(run, 7)).toHaveLength(1);
}

test('a merge GitHub applied but answered pending ends merge#1 merged, runs done#1 and completes the run, with one merge request and no sail-blocked', async () => {
  const run = await answered({ ...PENDING, applied: true });
  expectRecovered(run, 'passed', 'the merge answered pending; a re-read found it merged');
});

test('a merge GitHub applied whose answer was lost ends merge#1 passed and merged, runs done#1 and completes the run', async () => {
  const run = await answered({ ...LOST, applied: true });
  expectRecovered(run, 'passed', "the merge's answer was lost; a re-read found it merged");
});

test('a merge answered pending that did not happen still hands back with merge pending', async () => {
  const run = await answered(PENDING);
  expect({
    code: run.code,
    message: run.end.message,
    done: ended(run).includes('done#1'),
    merge: outputOf(run, 'merge#1'),
    open: run.pulls.find((each) => each.number === 7)?.state,
    merges: merges(run, 7).length,
  }).toEqual({
    code: EXIT_FAILED,
    message: 'handed back: merge pending',
    done: false,
    merge: { state: 'pending', reason: 'Merge pending' },
    open: 'open',
    merges: 1,
  });
});

test('a merge answered pending that GitHub reports merged without its merge commit hands back with merge pending', async () => {
  const run = await observe(
    {
      pulls: [{ number: 7, branch: 'sail/ADW-1-chain', ticket: 'ADW-1' }],
      github: (world) =>
        world.inject('PUT /pulls/7/merge', {
          status: 200,
          applied: true,
          // Read once the world has merged it: GitHub reports it merged, with no merge commit.
          get body() {
            const pull = world.pullRequests.find((each) => each.number === 7);
            if (pull !== undefined) pull.mergeCommitSha = null;
            return PENDING.body;
          },
        }),
    },
    ['#7', '--workflow', 'pr-to-main'],
  );
  expect({
    code: run.code,
    message: run.end.message,
    done: ended(run).includes('done#1'),
    merge: outputOf(run, 'merge#1'),
    merges: merges(run, 7).length,
  }).toEqual({
    code: EXIT_FAILED,
    message: 'handed back: merge pending',
    done: false,
    merge: { state: 'pending', reason: 'Merge pending' },
    merges: 1,
  });
});

test('a failed merge call that did not happen still ends merge#1 in error and hands back with merge failed', async () => {
  const run = await answered(LOST);
  expect({
    code: run.code,
    message: run.end.message,
    outcome: run.results['merge#1']?.outcome,
    done: ended(run).includes('done#1'),
    open: run.pulls.find((each) => each.number === 7)?.state,
    merges: merges(run, 7).length,
  }).toEqual({
    code: EXIT_FAILED,
    message: 'handed back: merge failed',
    outcome: 'error',
    done: false,
    open: 'open',
    merges: 1,
  });
});

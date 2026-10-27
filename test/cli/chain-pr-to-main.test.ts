// The chain fixture's `pr-to-main`, by hand: `sail '#<n>' --workflow pr-to-main` in a clone of the fixture
// (`test/fixtures/chain/.sail/`) on every real adapter but the harness. The workspace is git-worktree over a local bare
// origin, the scripted GitHub is served on 127.0.0.1 and follows pushes, and the scripted Linear holds the ticket. Each
// run is a `sail` process of its own, whose script steps' `sail port` reach the worlds over HTTP, so what GitHub was
// asked is read from the world's request log. This is the fixture's first test of `run.all()` inside `run.loop()`. The
// ways it gives up are in chain-pr-to-main-hand-back.test.ts, and the merge's guards in chain-pr-to-main-merge-guards.test.ts.
//
// A pull request cut from a `main` that has since moved merges after one fix pass: `security#1` finds one `high` thing,
// `fix#1` is given it, the six reviewers run again, `update` merges `main` in and pushes a new head, `tests` and
// `checks` pass, `gate` reads the label and the head, and `merge` squashes at that head. One run, observed once, read by
// the cases below. No wait is a duration: the fixture's checks stage waits CHAIN_CHECKS_INTERVAL, 0.05 s here, between its few reads.
import { expect, test } from 'bun:test';
import { EXIT_OK } from '../../src/cli/exit-codes';
import { type Observed, observe } from '../helpers/chain';
import { worldMergeSha } from '../helpers/github-world';
import { ended, groups, merges, outputOf, REVIEWERS } from '../helpers/pr-to-main';

let merged: Promise<Observed> | undefined;
/** PR 7, labelled `sail`, from ADW-1's branch, behind `main`: run once, and kept for the cases. */
const mergedRun = (): Promise<Observed> => {
  merged ??= observe({ pulls: [{ number: 7, branch: 'sail/ADW-1-chain', ticket: 'ADW-1' }] }, [
    '#7',
    '--workflow',
    'pr-to-main',
  ]);
  return merged;
};

test('pr-to-main on a pull request behind main completes in two passes: six reviewers at once per pass, then fix#1, push#1, update#1, tests#1, checks#1, gate#1, merge#1 and done#1', async () => {
  const run = await mergedRun();
  expect({ code: run.code, stderr: run.stderr, status: run.end.status, issues: run.issues }).toEqual({
    code: EXIT_OK,
    stderr: '',
    status: 'completed',
    issues: [],
  });
  expect(groups(run)).toEqual([REVIEWERS.map((name) => `${name}#1`), REVIEWERS.map((name) => `${name}#2`)]);
  const iterations = run.events.filter((event) => event.type === 'loop:iteration');
  expect(iterations.map((event) => (event as unknown as { iteration: number }).iteration)).toEqual([1, 2]);
  expect(ended(run).filter((key) => !REVIEWERS.some((name) => key.startsWith(`${name}#`)))).toEqual([
    'fix#1',
    'push#1',
    'update#1',
    'tests#1',
    'checks#1',
    'gate#1',
    'merge#1',
    'done#1',
  ]);
  expect(run.end.result).toMatchObject({ passes: 2 });
});

test("the first pass fails on security#1's one high finding, and fix#1 is given exactly that finding as its feedback", async () => {
  const run = await mergedRun();
  expect(run.feedback).toEqual({
    'fix#1': {
      findings: [
        {
          severity: 'high',
          file: 'chain/change.md',
          title: 'Unchecked input',
          detail: 'The change trusts a value it should check.',
        },
      ],
    },
  });
  // The other five reviewers of that pass found nothing, so the one finding is the whole of the feedback.
  const first = REVIEWERS.map((name) => run.results[`${name}#1`]?.output as { findings: unknown[] });
  expect(first.map((output) => output.findings.length)).toEqual([0, 0, 0, 0, 1, 0]);
});

test('a push with nothing new succeeds as push#1, and update#1 merges main in and pushes a new head, which tests#1 and checks#1 then run at', async () => {
  const run = await mergedRun();
  const pushed = outputOf<{ headSha: string }>(run, 'push#1').headSha;
  const updated = outputOf<{ state: string; headSha: string }>(run, 'update#1');
  expect(run.results['push#1']?.outcome).toBe('passed');
  expect(updated.state).toBe('merged');
  expect(updated.headSha).not.toBe(pushed);
  const pull = run.pulls.find((each) => each.number === 7);
  expect(pull?.headSha).toBe(updated.headSha);
  expect(
    run.events.filter((event) => event.type === 'codehost:pushed').map((event) => (event as { key?: string }).key),
  ).toEqual(['push#1', 'update#1']);
});

test('the checks stage reads past a pending check: it read the pull request and the check-runs of the new head until test passed', async () => {
  const run = await mergedRun();
  const head = outputOf<{ headSha: string }>(run, 'update#1').headSha;
  const reads = run.routes.filter((route) => route.startsWith(`GET /repos/o/r/commits/${head}/check-runs`));
  expect(reads).toHaveLength(2);
  expect(run.results['checks#1']?.output).toEqual({ verdict: 'passed', checks: [{ name: 'test', status: 'passed' }] });
  expect(run.results['gate#1']?.output).toEqual({ open: true, base: 'main', headSha: head, labelled: true });
});

test("the world got exactly one merge request, a squash at the new head, after its last check-runs read, and codehost:merged carries the world's merge sha", async () => {
  const run = await mergedRun();
  const head = outputOf<{ headSha: string }>(run, 'update#1').headSha;
  expect(merges(run, 7)).toEqual([{ merge_method: 'squash', sha: head }]);
  const at = run.routes.indexOf('PUT /repos/o/r/pulls/7/merge');
  const lastRead = run.routes.findLastIndex((route) => route.includes('/check-runs'));
  expect(at).toBeGreaterThan(lastRead);
  const [event] = run.events.filter((each) => each.type === 'codehost:merged') as unknown as {
    key: string;
    sha: string;
    method: string;
    number: number;
  }[];
  expect(event).toMatchObject({ key: 'merge#1', number: 7, method: 'squash', sha: worldMergeSha(7, head) });
  expect(run.pulls.find((each) => each.number === 7)?.mergeCommitSha).toBe(worldMergeSha(7, head));
});

test('ADW-1 is Done in the Linear world, with the merged comment naming the pull request and the merge commit', async () => {
  const run = await mergedRun();
  const head = outputOf<{ headSha: string }>(run, 'update#1').headSha;
  expect(run.tickets[1]?.state).toBe('Done');
  expect((run.tickets[1]?.comments ?? []).map((comment) => comment.body)).toEqual([
    `sail run ${run.dir} merged https://github.com/o/r/pull/7 as ${worldMergeSha(7, head)}`,
  ]);
});

test("afterwards the run's workspace and lease are released, and the clone's HEAD and status are what they were", async () => {
  const run = await mergedRun();
  expect({
    released: run.events
      .map((event) => event.type)
      .filter((type) => /^workspace:(released|lease_released)$/.test(type)),
    leases: run.leases,
    worktrees: run.worktrees,
    after: run.after,
  }).toEqual({
    released: ['workspace:released', 'workspace:lease_released'],
    leases: [],
    worktrees: [run.clone],
    after: run.before,
  });
});

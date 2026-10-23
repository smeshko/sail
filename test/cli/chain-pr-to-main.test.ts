// The chain fixture's `pr-to-main`, by hand: `sail '#<n>' --workflow pr-to-main` in a clone of the fixture
// (`test/fixtures/chain/.sail/`) on every real adapter but the harness. The workspace is git-worktree over a local bare
// origin, the scripted GitHub is served on 127.0.0.1 and follows pushes, and the scripted Linear holds the ticket. Each
// run is a `sail` process of its own, whose script steps' `sail port` reach the worlds over HTTP, so what GitHub was
// asked is read from the world's request log. This is the fixture's first test of `run.all()` inside `run.loop()`.
//
// A pull request cut from a `main` that has since moved merges after one fix pass: `security#1` finds one `high` thing,
// `fix#1` is given it, the six reviewers run again, `update` merges `main` in and pushes a new head, `tests` and
// `checks` pass, `gate` reads the label and the head, and `merge` squashes at that head. One run, observed once, read by
// the cases below. No wait is a duration: the fixture's checks stage waits one second between its few reads.
import { expect, test } from 'bun:test';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { EXIT_FAILED, EXIT_OK } from '../../src/cli/exit-codes';
import { type Observed, observe, removeLabelAtAllStart } from '../helpers/chain';
import { worldMergeSha } from '../helpers/github-world';

const REVIEWERS = ['style', 'architecture', 'side-effects', 'performance', 'security', 'coverage-check'];

/** The keys the first `all:start` of each pass lists, in order. */
const groups = (run: Observed): string[][] =>
  run.events
    .filter((event) => event.type === 'all:start')
    .map((event) => (event as unknown as { keys: string[] }).keys);

/** The keys of every call that ended, in the order they ended. */
const ended = (run: Observed): string[] =>
  run.events.filter((event) => event.type === 'stage:end').map((event) => (event as unknown as { key: string }).key);

/** The output of call `key`, which the run must have made. */
function outputOf<T>(run: Observed, key: string): T {
  const result = run.results[key];
  if (result === undefined) throw new Error(`the run made no call ${key}`);
  return result.output as T;
}

/** The merge's request bodies, from the world's log. */
const merges = (run: Observed, number: number) =>
  run.requests
    .filter((request) => request.method === 'PUT' && request.path === `/repos/o/r/pulls/${number}/merge`)
    .map((request) => request.body);

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

test('a pull request whose check test never registers gets no merge request: its checks read an empty list every time, and an empty read never passes', async () => {
  const run = await observe({ pulls: [{ number: 8, branch: 'sail/ADW-1-silent', ticket: 'ADW-1' }], silent: [8] }, [
    '#8',
    '--workflow',
    'pr-to-main',
  ]);
  const reads = run.routes.filter((route) => route.includes('/check-runs'));
  expect({
    code: run.code,
    merges: merges(run, 8),
    checks: run.results['checks#1']?.output,
    reads: reads.length,
    merged: run.events.filter((event) => event.type === 'codehost:merged'),
    open: run.pulls.find((each) => each.number === 8)?.state,
  }).toEqual({
    code: EXIT_FAILED,
    merges: [],
    checks: { verdict: 'pending', checks: [] },
    reads: 4,
    merged: [],
    open: 'open',
  });
});

// The ways pr-to-main gives up. Each run below ends `failed`, sends no merge request, leaves its pull request open and
// releases its lease and worktree. A hand-back comments, swaps `sail` for `sail-blocked` (the removal first, so no poll
// can list the pull request between the two calls), and comments on the ticket, whose state it leaves. A removed label
// is a stop: two comments and no label change.

/** The harness answers where `security` finds one `high` thing on every call, not only on the first. */
const securityAlwaysHigh = (answers: Record<string, Record<string, unknown>[]>) => {
  const high = answers['security#1'];
  delete answers['security#1'];
  answers.security = high ?? [];
};

/** Every `<METHOD> <path under /repos/o/r/issues/<number>>` the world got, as the request log held it, in order. */
const issueCalls = (run: Observed, number: number): string[] =>
  run.requests
    .filter((request) => request.path.startsWith(`/repos/o/r/issues/${number}/`) && request.method !== 'GET')
    .map((request) => `${request.method} ${request.path.slice(`/repos/o/r/issues/${number}`.length)}`);

/** The bodies of the POSTs that add labels to pull request `number`. */
const labelBodies = (run: Observed, number: number): unknown[] =>
  run.requests
    .filter((request) => request.method === 'POST' && request.path === `/repos/o/r/issues/${number}/labels`)
    .map((request) => request.body);

/** The comments the world holds on pull request `number`. */
const commentsOn = (run: Observed, number: number): string[] =>
  (run.pulls.find((each) => each.number === number)?.comments ?? []).map((comment) => comment.body);

/** What every give-up shares: failed, nothing merged, still open, and the lease, worktree and clone as they were. */
function expectGivenUp(run: Observed, number: number): void {
  expect({
    code: run.code,
    status: run.end.status,
    merges: merges(run, number),
    merged: run.events.filter((event) => event.type === 'codehost:merged'),
    open: run.pulls.find((each) => each.number === number)?.state,
    leases: run.leases,
    worktrees: run.worktrees,
    after: run.after,
    issues: run.issues,
  }).toEqual({
    code: EXIT_FAILED,
    status: 'failed',
    merges: [],
    merged: [],
    open: 'open',
    leases: [],
    worktrees: [run.clone],
    after: run.before,
    issues: [],
  });
}

/** The hand-back's label swap: the removal, then an addition of only `sail-blocked`, and nothing else. */
const SWAP = ['DELETE /labels/sail', 'POST /labels'];

let red: Promise<Observed> | undefined;
/** PR 7 labelled `sail` and `ci-red`, behind `main`: run once, and kept for the cases. */
const redCheck = (): Promise<Observed> => {
  red ??= observe({ pulls: [{ number: 7, branch: 'sail/ADW-1-red', ticket: 'ADW-1', labels: ['sail', 'ci-red'] }] }, [
    '#7',
    '--workflow',
    'pr-to-main',
  ]);
  return red;
};

test('a check that stays red: three passes, fix#2 is given the failed check, no reviewer runs on pass 3, and the run is handed back with checks failed', async () => {
  const run = await redCheck();
  expectGivenUp(run, 7);
  expect(run.end.message).toBe('handed back: checks failed');
  expect(groups(run)).toEqual([REVIEWERS.map((name) => `${name}#1`), REVIEWERS.map((name) => `${name}#2`)]);
  expect(ended(run).filter((key) => !REVIEWERS.some((name) => key.startsWith(`${name}#`)))).toEqual([
    'fix#1',
    'push#1',
    'update#1',
    'tests#1',
    'checks#1',
    'fix#2',
    'push#2',
    'update#2',
    'tests#2',
    'checks#2',
    'hand-back#1',
  ]);
  expect(run.feedback['fix#2']).toEqual({ checks: [{ name: 'test', status: 'failed' }] });
  expect(run.results['checks#1']?.output).toEqual({ verdict: 'failed', checks: [{ name: 'test', status: 'failed' }] });
  expect(run.results['checks#2']?.output).toEqual({ verdict: 'failed', checks: [{ name: 'test', status: 'failed' }] });
});

test('the hand-back of a red check comments with the reason and the failed check, swaps sail for sail-blocked with the removal first, and comments on the ticket, whose state is untouched', async () => {
  const run = await redCheck();
  const [comment] = commentsOn(run, 7);
  expect(commentsOn(run, 7)).toHaveLength(1);
  expect(comment).toBe(
    `sail run ${run.dir} handed this pull request back: checks failed\n\n\`\`\`\n- test: failed\n\`\`\`\n`,
  );
  expect(issueCalls(run, 7)).toEqual(['POST /comments', ...SWAP]);
  expect(labelBodies(run, 7)).toEqual([{ labels: ['sail-blocked'] }]);
  expect(run.pulls.find((each) => each.number === 7)?.labels).toEqual(['ci-red', 'sail-blocked']);
  expect(run.tickets[1]?.state).toBe('Todo');
  expect((run.tickets[1]?.comments ?? []).map((each) => each.body)).toEqual([
    `sail run ${run.dir} handed pull request 7 back: checks failed`,
  ]);
});

test('must-fix findings on every pass: the third pass hands back with must-fix findings remain and the findings in the comment, after exactly two fix calls and no fourth pass', async () => {
  const run = await observe(
    { pulls: [{ number: 7, branch: 'sail/ADW-1-fix', ticket: 'ADW-1' }], harness: securityAlwaysHigh },
    ['#7', '--workflow', 'pr-to-main'],
  );
  expectGivenUp(run, 7);
  expect(run.end.message).toBe('handed back: must-fix findings remain');
  expect(groups(run).map((keys) => keys.at(-2))).toEqual(['security#1', 'security#2', 'security#3']);
  expect(ended(run).filter((key) => key.startsWith('fix#'))).toEqual(['fix#1', 'fix#2']);
  expect(run.events.some((event) => event.type === 'loop:exit' && JSON.stringify(event).includes('exceeded'))).toBe(
    false,
  );
  expect(commentsOn(run, 7)[0]).toContain(
    '- high chain/change.md: Unchecked input. The change trusts a value it should check.',
  );
});

test('tests that fail on every pass: the third pass hands back with tests failed and the failing test in the comment', async () => {
  const run = await observe({ pulls: [{ number: 7, branch: 'sail/ADW-1-tests', ticket: 'ADW-1', testsFail: true }] }, [
    '#7',
    '--workflow',
    'pr-to-main',
  ]);
  expectGivenUp(run, 7);
  expect(run.end.message).toBe('handed back: tests failed');
  expect(ended(run).filter((key) => key.startsWith('tests#'))).toEqual(['tests#1', 'tests#2']);
  expect(commentsOn(run, 7)[0]).toContain('- chain › stays green (test/chain.test.ts): chain/tests-fail is present');
});

test('a conflict with main: pass 2 update exits failed with the conflicting file, the merge is aborted so no MERGE_HEAD is left, and the run hands back with conflict with main', async () => {
  const run = await observe(
    {
      pulls: [{ number: 7, branch: 'sail/ADW-1-conflict', ticket: 'ADW-1', conflict: true }],
      // The workspace is gone when the run ends: its merge state is written where the hand-back stage runs, after update.
      prepare: (sail) => {
        const file = join(sail, 'workflows', 'pr-to-main', 'stages', 'hand-back', 'run.sh');
        const text = readFileSync(file, 'utf8');
        const probe =
          'if [ -e "$(git rev-parse --git-path MERGE_HEAD)" ]; then echo merging; else echo clean; fi >"$STAGE_OUT/merge-state.txt"\n';
        writeFileSync(
          file,
          text.replace('set -euo pipefail\n', () => `set -euo pipefail\n${probe}`),
        );
      },
      capture: ['merge-state.txt'],
    },
    ['#7', '--workflow', 'pr-to-main'],
  );
  expectGivenUp(run, 7);
  expect(run.end.message).toBe('handed back: conflict with main');
  expect(run.results['update#1']).toMatchObject({
    outcome: 'failed',
    output: { state: 'conflict', files: ['conflict.txt'] },
  });
  expect(run.captured['hand-back#1/merge-state.txt']).toBe('clean\n');
  expect(commentsOn(run, 7)[0]).toContain('- conflict.txt');
});

test('checks still pending when the tries run out: a test that never registers hands back with checks still pending after four reads, and no merge request', async () => {
  const run = await observe({ pulls: [{ number: 8, branch: 'sail/ADW-1-silent', ticket: 'ADW-1' }], silent: [8] }, [
    '#8',
    '--workflow',
    'pr-to-main',
  ]);
  expectGivenUp(run, 8);
  expect(run.end.message).toBe('handed back: checks still pending');
  expect(run.routes.filter((route) => route.includes('/check-runs'))).toHaveLength(4);
  expect(commentsOn(run, 8)[0]).toContain('no check ran');
  expect(issueCalls(run, 8)).toEqual(['POST /comments', ...SWAP]);
});

test('a label removed before the gate stops the merge: one comment on the pull request and one on the ticket, no label request, no sail-blocked, and the run fails with the removed label as its reason', async () => {
  const run = await observe(
    {
      pulls: [{ number: 7, branch: 'sail/ADW-1-stop', ticket: 'ADW-1' }],
      // The last reviewer takes a moment, so the label is gone minutes before the gate, as a person would remove it.
      harness: (answers) => {
        const [coverage] = answers['coverage-check'] ?? [];
        if (coverage !== undefined) coverage.delayMs = 1500;
      },
    },
    ['#7', '--workflow', 'pr-to-main'],
    (chain) => removeLabelAtAllStart(chain, 7, 'sail'),
  );
  expectGivenUp(run, 7);
  expect(run.end.message).toBe('the designation label was removed before the merge');
  const said = `sail run ${run.dir} did not merge: the label sail was removed`;
  expect(commentsOn(run, 7)).toEqual([said]);
  expect((run.tickets[1]?.comments ?? []).map((each) => each.body)).toEqual([said]);
  expect(issueCalls(run, 7)).toEqual(['POST /comments']);
  expect(run.pulls.find((each) => each.number === 7)?.labels).toEqual([]);
  expect(run.results['gate#1']?.output).toMatchObject({ labelled: false });
});

// Round 1 of the review's regression cases. Each changes the world at a moment the run can't see coming, by a line added
// to one stage's copied script: the change lands after that stage has written its answer, and the stages after it are
// the ones under test.

/** Adds `lines` to the copied script of `stage`, at its start (after `set -euo pipefail`) or its end. */
const addTo =
  (stage: string, where: 'start' | 'end', lines: string) =>
  (sail: string): void => {
    const file = join(sail, 'workflows', 'pr-to-main', 'stages', stage, 'run.sh');
    const text = readFileSync(file, 'utf8');
    writeFileSync(
      file,
      where === 'end'
        ? `${text}${lines}\n`
        : text.replace('set -euo pipefail\n', () => `set -euo pipefail\n${lines}\n`),
    );
  };

/** Moves `ref` on the bare origin by one empty commit, from the workspace, with nothing on stdout. */
const moveOnOrigin = (ref: string) =>
  [
    `git fetch -q origin ${ref}`,
    `moved=$(git commit-tree -p FETCH_HEAD -m 'moved under the run' 'FETCH_HEAD^{tree}')`,
    `git push -q origin "$moved:refs/heads/${ref}" >/dev/null 2>&1`,
  ].join('\n');

test('main moving after the checks (another pull request merged) refuses the merge: no merge request, and the run hands back saying main moved', async () => {
  const run = await observe(
    {
      pulls: [{ number: 7, branch: 'sail/ADW-1-main-moves', ticket: 'ADW-1' }],
      prepare: addTo('gate', 'end', moveOnOrigin('main')),
    },
    ['#7', '--workflow', 'pr-to-main'],
  );
  expectGivenUp(run, 7);
  expect(run.end.message).toBe('handed back: merge refused');
  expect(run.results['gate#1']?.output).toMatchObject({ labelled: true, open: true, base: 'main' });
  expect(run.results['merge#1']?.output).toMatchObject({ state: 'refused' });
  expect(commentsOn(run, 7)[0]).toContain('main moved past the head the checks ran at');
  expect(issueCalls(run, 7)).toEqual(['POST /comments', ...SWAP]);
});

test('a label removed after the gate read it still stops the merge: the merge step reads the pull request again, sends no merge request, and stops without sail-blocked', async () => {
  const run = await observe(
    {
      pulls: [{ number: 7, branch: 'sail/ADW-1-late-label', ticket: 'ADW-1' }],
      prepare: addTo('gate', 'end', 'sail port codehost remove-label "$(cat "$INPUT_PR")" sail >/dev/null'),
    },
    ['#7', '--workflow', 'pr-to-main'],
  );
  expectGivenUp(run, 7);
  expect(run.end.message).toBe('the designation label was removed before the merge');
  expect(run.results['gate#1']?.output).toMatchObject({ labelled: true });
  const said = `sail run ${run.dir} did not merge: the label sail was removed`;
  expect(commentsOn(run, 7)).toEqual([said]);
  expect((run.tickets[1]?.comments ?? []).map((each) => each.body)).toEqual([said]);
  // The removal is the one the test made; the run itself only commented.
  expect(issueCalls(run, 7)).toEqual(['DELETE /labels/sail', 'POST /comments']);
  expect(labelBodies(run, 7)).toEqual([]);
});

test('a push to the pull request after its checks passed hands it back at the gate: the head moved, and no merge request is sent', async () => {
  const run = await observe(
    {
      pulls: [{ number: 7, branch: 'sail/ADW-1-head-moves', ticket: 'ADW-1' }],
      prepare: addTo('checks', 'end', moveOnOrigin('"$BRANCH"')),
    },
    ['#7', '--workflow', 'pr-to-main'],
  );
  expectGivenUp(run, 7);
  expect(run.end.message).toBe('handed back: the pull request changed before the merge');
  const head = outputOf<{ headSha: string }>(run, 'update#1').headSha;
  expect(outputOf<{ headSha: string }>(run, 'gate#1').headSha).not.toBe(head);
  expect(commentsOn(run, 7)[0]).toContain(`expected head: ${head}`);
});

test('a fix that commits sends the next pass back to the reviewers: a red check with a commit from each fix reviews on all three passes', async () => {
  const run = await observe(
    {
      pulls: [{ number: 7, branch: 'sail/ADW-1-red-commits', ticket: 'ADW-1', labels: ['sail', 'ci-red'] }],
      prepare: addTo('push', 'start', "git commit -q --allow-empty -m 'a commit of the fix'"),
    },
    ['#7', '--workflow', 'pr-to-main'],
  );
  expectGivenUp(run, 7);
  expect(run.end.message).toBe('handed back: checks failed');
  expect(groups(run)).toEqual([1, 2, 3].map((pass) => REVIEWERS.map((name) => `${name}#${pass}`)));
});

test('a fix whose commits touch a file outside src/ and test/ is never pushed: push#1 refuses with the file, and the run hands back', async () => {
  const run = await observe(
    {
      pulls: [{ number: 7, branch: 'sail/ADW-1-outside', ticket: 'ADW-1' }],
      prepare: addTo(
        'push',
        'start',
        [
          'mkdir -p .github/workflows src',
          'echo changed >.github/workflows/test.yml',
          'echo fixed >src/fixed.ts',
          'git add .github/workflows/test.yml src/fixed.ts',
          "git commit -q -m 'a fix that reaches past its paths'",
        ].join('\n'),
      ),
    },
    ['#7', '--workflow', 'pr-to-main'],
  );
  expectGivenUp(run, 7);
  expect(run.end.message).toBe('handed back: fix changed files outside src/ and test/');
  expect(run.results['push#1']).toMatchObject({ outcome: 'failed', output: { files: ['.github/workflows/test.yml'] } });
  expect(run.events.filter((event) => event.type === 'codehost:pushed')).toEqual([]);
  expect(commentsOn(run, 7)[0]).toContain('- .github/workflows/test.yml');
});

test('a required check that was skipped never passes: the checks stay pending to the last try, and the run hands back with the skipped check', async () => {
  const run = await observe(
    { pulls: [{ number: 7, branch: 'sail/ADW-1-skipped', ticket: 'ADW-1', labels: ['sail', 'ci-skipped'] }] },
    ['#7', '--workflow', 'pr-to-main'],
  );
  expectGivenUp(run, 7);
  expect(run.end.message).toBe('handed back: checks still pending');
  expect(run.results['checks#1']?.output).toEqual({
    verdict: 'pending',
    checks: [{ name: 'test', status: 'skipped' }],
  });
  expect(commentsOn(run, 7)[0]).toContain('- test: skipped');
});

test('a label removed during a run that then gives up is a stop, not a hand-back: no sail-blocked on a pull request a person took', async () => {
  const run = await observe(
    {
      pulls: [{ number: 7, branch: 'sail/ADW-1-red-taken', ticket: 'ADW-1', labels: ['sail', 'ci-red'] }],
      harness: (answers) => {
        const [coverage] = answers['coverage-check'] ?? [];
        if (coverage !== undefined) coverage.delayMs = 1500;
      },
    },
    ['#7', '--workflow', 'pr-to-main'],
    (chain) => removeLabelAtAllStart(chain, 7, 'sail'),
  );
  expectGivenUp(run, 7);
  expect(run.end.message).toBe('the designation label was removed before the merge');
  const said = `sail run ${run.dir} did not merge: the label sail was removed`;
  expect(commentsOn(run, 7)).toEqual([said]);
  expect(issueCalls(run, 7)).toEqual(['POST /comments']);
  expect(run.pulls.find((each) => each.number === 7)?.labels).toEqual(['ci-red']);
});

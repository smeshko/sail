// The chain fixture's `pr-to-main`, by hand: `sail '#<n>' --workflow pr-to-main` in a clone of the fixture
// (`test/fixtures/chain/.sail/`) on every real adapter but the harness. The workspace is git-worktree over a local bare
// origin, the scripted GitHub is served on 127.0.0.1 and follows pushes, and the scripted Linear holds the ticket. Each
// run is a `sail` process of its own, whose script steps' `sail port` reach the worlds over HTTP, so what GitHub was
// asked is read from the world's request log.
//
// The ways pr-to-main gives up. Each run below ends `failed`, sends no merge request, leaves its pull request open and
// releases its lease and worktree. A hand-back comments, swaps `sail` for `sail-blocked` (the removal first, so no poll
// can list the pull request between the two calls), and comments on the ticket, whose state it leaves. A removed label
// is a stop: two comments and no label change.
import { expect, test } from 'bun:test';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { EXIT_FAILED } from '../../src/cli/exit-codes';
import { type Observed, observe, removeLabelAtAllStart } from '../helpers/chain';
import {
  commentsOn,
  ended,
  expectGivenUp,
  groups,
  issueCalls,
  labelBodies,
  merges,
  REVIEWERS,
  SWAP,
  securityAlwaysHigh,
} from '../helpers/pr-to-main';

let silent: Promise<Observed> | undefined;
/** PR 8, whose check `test` never registers: run once, and kept for the two cases that read it. */
const silentRun = (): Promise<Observed> => {
  silent ??= observe({ pulls: [{ number: 8, branch: 'sail/ADW-1-silent', ticket: 'ADW-1' }], silent: [8] }, [
    '#8',
    '--workflow',
    'pr-to-main',
  ]);
  return silent;
};

test('a pull request whose check test never registers gets no merge request: its checks read an empty list every time, and an empty read never passes', async () => {
  const run = await silentRun();
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
  const run = await silentRun();
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

// The chain fixture's `pr-to-main`, by hand: `sail '#<n>' --workflow pr-to-main` in a clone of the fixture
// (`test/fixtures/chain/.sail/`) on every real adapter but the harness. The workspace is git-worktree over a local bare
// origin, the scripted GitHub is served on 127.0.0.1 and follows pushes, and the scripted Linear holds the ticket. Each
// run is a `sail` process of its own, whose script steps' `sail port` reach the worlds over HTTP, so what GitHub was
// asked is read from the world's request log.
//
// Round 1 of the review's regression cases. Each changes the world at a moment the run can't see coming, by a line added
// to one stage's copied script: the change lands after that stage has written its answer, and the stages after it are
// the ones under test.
import { expect, test } from 'bun:test';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { observe, removeLabelAtAllStart } from '../helpers/chain';
import {
  commentsOn,
  expectGivenUp,
  groups,
  issueCalls,
  labelBodies,
  outputOf,
  REVIEWERS,
  SWAP,
  securityAlwaysHigh,
} from '../helpers/pr-to-main';

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

// Round 2's regression cases.

test('a fix that moves a file from outside src/ into it is refused too: the move deletes the outside file, which push names', async () => {
  const run = await observe(
    {
      pulls: [{ number: 7, branch: 'sail/ADW-1-moved-in', ticket: 'ADW-1' }],
      prepare: addTo(
        'push',
        'start',
        "mkdir -p src && git mv chain/7.md src/7.md && git commit -q -m 'a move into src'",
      ),
    },
    ['#7', '--workflow', 'pr-to-main'],
  );
  expectGivenUp(run, 7);
  expect(run.end.message).toBe('handed back: fix changed files outside src/ and test/');
  expect(run.results['push#1']).toMatchObject({ outcome: 'failed', output: { files: ['chain/7.md'] } });
  expect(run.events.filter((event) => event.type === 'codehost:pushed')).toEqual([]);
});

test('details made of one long run of backticks still give a comment under the host limit, and the hand-back swaps the label', async () => {
  const run = await observe(
    {
      pulls: [{ number: 7, branch: 'sail/ADW-1-backticks', ticket: 'ADW-1' }],
      harness: (answers) => {
        securityAlwaysHigh(answers);
        for (const answer of answers.security ?? []) {
          const output = answer.output as { findings?: { detail: string }[] } | undefined;
          for (const finding of output?.findings ?? []) finding.detail = '`'.repeat(70_000);
        }
      },
    },
    ['#7', '--workflow', 'pr-to-main'],
  );
  expectGivenUp(run, 7);
  expect(run.end.message).toBe('handed back: must-fix findings remain');
  const [comment = ''] = commentsOn(run, 7);
  expect(Buffer.byteLength(comment)).toBeLessThan(65_536);
  expect(comment).toContain('(the details are cut at 60,000 bytes)');
  expect(issueCalls(run, 7)).toEqual(['POST /comments', ...SWAP]);
});

// Round 3's regression case.

test('details cut inside a multi-byte character still hand back under a UTF-8 locale: the comment is posted and the label swapped', async () => {
  const run = await observe(
    {
      pulls: [{ number: 7, branch: 'sail/ADW-1-multibyte', ticket: 'ADW-1' }],
      // The details open with `- high chain/change.md: Unchecked input. `, 41 bytes, so the emoji spans bytes 59,998 to
      // 60,001 and the cut at 60,000 splits it. macOS awk refuses a split character under a UTF-8 locale; Linux awk
      // reads bytes, so the case was red only on macOS.
      env: { LC_ALL: 'en_US.UTF-8' },
      harness: (answers) => {
        securityAlwaysHigh(answers);
        for (const answer of answers.security ?? []) {
          const output = answer.output as { findings?: { detail: string }[] } | undefined;
          for (const finding of output?.findings ?? []) finding.detail = `${'a'.repeat(59_957)}\u{1F600} and after`;
        }
      },
    },
    ['#7', '--workflow', 'pr-to-main'],
  );
  expectGivenUp(run, 7);
  expect(run.end.message).toBe('handed back: must-fix findings remain');
  expect(commentsOn(run, 7)[0]).toContain('(the details are cut at 60,000 bytes)');
  expect(issueCalls(run, 7)).toEqual(['POST /comments', ...SWAP]);
});

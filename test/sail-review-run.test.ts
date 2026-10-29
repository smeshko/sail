// sail's own `review` workflow, end to end through the CLI on the fakes: `sail '#7' --workflow review` in a temporary
// repository that holds a copy of the repository's own `.sail/`, its ports all fake and, where a case seeds one, a fake
// Jev. The first cases are about check-fix: Jev's clear yes on every targeted finding ends a fix round without an agent
// session, anything else leaves it to the agent, with Jev's answers as its hint. One is about the tickets it files. The
// rest are about landing: a check still red after its rerun goes to fix, a rejected merge merges the base in, and both
// take the fix passes left.
import { expect, test } from 'bun:test';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readJournal } from '../src/engine/journal';
import { readEvents } from '../src/events/consumers/ndjson';
import type { Summary } from '../src/events/summary';
import { seedHarness } from './helpers/fixture';
import { onlyRun } from './helpers/groom-fixture';
import { nouls, writeOwnSail } from './helpers/own-sail';
import { runCaptured } from './helpers/run-captured';
import { type TempRepo, withTempRepo } from './helpers/temp-repo';

const RUN = ['#7', '--workflow', 'review'];
const TARGETS = ['V1', 'D1', 'R2'];

/** Jev's seed: every targeted finding at `0.99` but those `overrides` names. */
const seed = (overrides: Record<string, number> = {}) =>
  nouls({
    'leak-1': overrides['leak-1'] ?? 0,
    'leak-2': 0,
    ...Object.fromEntries(TARGETS.map((id) => [id, overrides[id] ?? 0.99])),
  });

/** The repository's own `.sail/` on fakes, with fake pull request #7 pointed at commits the repository holds. */
function setUp(repo: TempRepo, jev?: object): void {
  writeOwnSail(repo, jev === undefined ? {} : { jev });
  const base = repo.git('rev-parse', 'HEAD').trim();
  writeFileSync(join(repo.dir, 'notes.txt'), 'a change\n');
  repo.git('add', 'notes.txt');
  repo.git('commit', '-m', 'the pull request');
  const head = repo.git('rev-parse', 'HEAD').trim();
  const prs = join(repo.dir, '.sail', 'fake', 'prs.json');
  writeFileSync(
    prs,
    readFileSync(prs, 'utf8')
      .replaceAll('cb9c6b50425ad5072892f561cc7459be4c65983d', head)
      .replaceAll('8cdaad7c30e274ed1e7ae6dfd185d6bd14087447', base),
  );
}

/** Changes fake pull request #7's seed: its checks, merges, base sha, whatever `change` sets. */
function editPullRequest(repo: TempRepo, change: Record<string, unknown>): void {
  const prs = join(repo.dir, '.sail', 'fake', 'prs.json');
  const world = JSON.parse(readFileSync(prs, 'utf8'));
  Object.assign(world.pullRequests[0], change);
  writeFileSync(prs, JSON.stringify(world));
}

/**
 * Commits `text` to `file` on a branch off the pull request's base, back on the pull request after, and makes that
 * commit #7's base sha: the base moved while the review ran.
 */
function moveBase(repo: TempRepo, file: string, text: string): string {
  const prs = JSON.parse(readFileSync(join(repo.dir, '.sail', 'fake', 'prs.json'), 'utf8'));
  repo.git('checkout', '-q', '-b', 'moved', prs.pullRequests[0].baseSha);
  writeFileSync(join(repo.dir, file), text);
  repo.git('add', file);
  repo.git('commit', '-q', '-m', 'the base moves');
  const moved = repo.git('rev-parse', 'HEAD').trim();
  repo.git('checkout', '-q', '-');
  editPullRequest(repo, { baseSha: moved });
  return moved;
}

/** `sail port codehost get-pull-request 7` in `repo`: its head, labels and comment bodies. */
async function pullRequest(repo: TempRepo): Promise<{ headSha: string; labels: string[]; comments: string[] }> {
  const { stdout } = await runCaptured(['port', 'codehost', 'get-pull-request', '7'], repo.dir, { env: repo.env });
  const pr = JSON.parse(stdout.trim().split('\n').at(-1) ?? 'null');
  return { headSha: pr.headSha, labels: pr.labels, comments: pr.comments.map((each: { body: string }) => each.body) };
}

/** The keys from merge#1 on: the landing. */
const landing = (keys: string[]) => keys.slice(keys.indexOf('merge#1'));

/** `sail '#7' --workflow review` in `repo`: its exit code and stderr, the keys its journal holds and its run directory. */
async function review(repo: TempRepo): Promise<{ code: number; stderr: string; keys: string[]; dir: string }> {
  const { code, stderr } = await runCaptured(RUN, repo.dir, { env: repo.env });
  let dir: string;
  try {
    dir = onlyRun(repo.dir);
  } catch (error) {
    throw new Error(`${error}\nexit ${code}\n${stderr}`);
  }
  return { code, stderr, keys: readJournal(dir).entries.map((entry) => entry.key), dir };
}

/** The `$STAGE_IN/jev.json` of a call, parsed. */
function jevHint(dir: string, stage: string, call: number): { asked: boolean; answers: { id: string; yes: number }[] } {
  const folder = readdirSync(dir).find((name) => name.replace(/^\d+-/, '') === stage);
  if (folder === undefined) throw new Error(`no ${stage} folder in ${dir}`);
  return JSON.parse(readFileSync(join(dir, folder, `call-${call}`, 'in', 'jev.json'), 'utf8'));
}

const asked = (dir: string, key: string) =>
  readEvents(dir).filter((event) => event.type === 'jev:asked' && (event as { key?: string }).key === key);

test('a leak-check Jev hit reaches the judge as L1', async () => {
  await withTempRepo(async (repo) => {
    setUp(repo, seed({ 'leak-1': 0.97 }));
    const sail = join(repo.dir, '.sail');
    const [answer] = JSON.parse(readFileSync(join(sail, 'fake', 'harness.json'), 'utf8')).judge;
    answer.output.decisions.push({
      finding: 'L1',
      verdict: 'drop',
      rationale: 'The planted line is harmless.',
      ticket: null,
    });
    seedHarness(sail, 'judge', [answer]);
    const { code, dir } = await review(repo);
    expect(code).toBe(0);
    const folder = readdirSync(dir).find((name) => name.endsWith('-judge'));
    const input = JSON.parse(readFileSync(join(dir, folder ?? '', 'call-1', 'in', 'findings.json'), 'utf8'));
    expect(input.findings).toContainEqual(
      expect.objectContaining({ id: 'L1', source: 'leak-check', file: 'notes.txt:1' }),
    );
    const leak = input.findings.find((finding: { id: string }) => finding.id === 'L1');
    expect(`${leak.title}\n${leak.detail}`).not.toContain('a change');
    expect(leak.detail).toContain('0.97');
    expect(leak.detail).toContain('0.8');
    expect(asked(dir, 'leak-check#1')).toHaveLength(1);
  });
}, 120_000);

test('with Jev answering every targeted finding a clear yes, jev-fix#1 runs, check-fix never does, and the fix loop ends after one round', async () => {
  await withTempRepo(async (repo) => {
    setUp(repo, seed());
    const { code, stderr, keys, dir } = await review(repo);
    expect({ code, stderr }).toEqual({ code: 0, stderr: '' });

    expect(keys.filter((key) => key.startsWith('check-fix#'))).toEqual([]);
    expect(keys.filter((key) => key.startsWith('fix#'))).toEqual(['fix#1']);
    const at = keys.indexOf('jev-fix#1');
    expect(keys.slice(at - 1, at + 3)).toEqual(['fix#1', 'jev-fix#1', 'validate#2', 'push#1']);
    expect(asked(dir, 'jev-fix#1')).toHaveLength(1);
    const summary = JSON.parse(readFileSync(join(dir, 'summary.json'), 'utf8')) as Summary;
    expect(summary.loops?.fix?.iterations).toBe(1);
  });
}, 120_000);

test.each([
  ['unclear', 0.6],
  ['a no', 0.05],
])(
  'with Jev answering R2 %s, check-fix#1 runs after jev-fix#1 with the answers as its hint',
  async (_name, yes) => {
    await withTempRepo(async (repo) => {
      setUp(repo, seed({ R2: yes }));
      const { code, stderr, keys, dir } = await review(repo);
      expect({ code, stderr }).toEqual({ code: 0, stderr: '' });

      const at = keys.indexOf('jev-fix#1');
      expect(keys.slice(at - 1, at + 1)).toEqual(['fix#1', 'jev-fix#1']);
      expect(keys).toContain('check-fix#1');
      const hint = jevHint(dir, 'check-fix', 1);
      expect(hint.asked).toBe(true);
      expect(hint.answers).toEqual([
        { id: 'V1', yes: 0.99 },
        { id: 'D1', yes: 0.99 },
        { id: 'R2', yes },
      ]);
      expect(asked(dir, 'jev-fix#1')).toHaveLength(1);
    });
  },
  120_000,
);

test('with no adapters.jev, check-fix runs beside validate every round as the fake seeds drive the loop', async () => {
  await withTempRepo(async (repo) => {
    setUp(repo);
    const { code, stderr, keys, dir } = await review(repo);
    expect({ code, stderr }).toEqual({ code: 0, stderr: '' });

    expect(keys.filter((key) => key.startsWith('check-fix#'))).toEqual(['check-fix#1', 'check-fix#2']);
    expect(keys.filter((key) => key.startsWith('jev-fix#'))).toEqual(['jev-fix#1', 'jev-fix#2']);
    expect([jevHint(dir, 'check-fix', 1).asked, jevHint(dir, 'check-fix', 1).answers]).toEqual([false, []]);
    expect(readEvents(dir).filter((event) => event.type === 'jev:asked')).toEqual([]);
  });
}, 120_000);

test('a low-severity finding the judge sends to a ticket is not filed, and a medium one is', async () => {
  await withTempRepo(async (repo) => {
    setUp(repo);
    const sail = join(repo.dir, '.sail');
    const [answer] = JSON.parse(readFileSync(join(sail, 'fake', 'harness.json'), 'utf8')).judge;
    const r4 = answer.output.decisions.find((each: { finding: string }) => each.finding === 'R4');
    Object.assign(r4, {
      verdict: 'ticket',
      ticket: { title: 'Rename tot', description: 'A terse name.', type: 'refactoring', trigger: 'reading show.ts' },
    });
    seedHarness(sail, 'judge', [answer]);
    const { code, stderr, dir } = await review(repo);
    expect({ code, stderr }).toEqual({ code: 0, stderr: '' });

    const folder = readdirSync(dir).find((name) => name.endsWith('-file-follow-ups'));
    const output = JSON.parse(readFileSync(join(dir, folder ?? '', 'call-1', 'result.json'), 'utf8')).output;
    expect(output.filed.map((each: { title: string }) => each.title)).toEqual([
      'sail runs sums call costs without rounding',
    ]);
  });
}, 120_000);

test('a check still red after its rerun goes to fix as a finding, then validate, push and merge again', async () => {
  await withTempRepo(async (repo) => {
    setUp(repo, seed());
    editPullRequest(repo, {
      checks: [{ name: 'verify', statuses: ['failed', 'failed', 'passed'], log: '(fail) a timing test\n 1 fail' }],
    });
    const { code, stderr, keys, dir } = await review(repo);
    expect({ code, stderr }).toEqual({ code: 0, stderr: '' });

    expect(landing(keys)).toEqual(['merge#1', 'sync-base#1', 'fix#2', 'validate#3', 'push#2', 'merge#2']);
    const findings = JSON.parse(
      readFileSync(
        join(dir, readdirSync(dir).find((name) => /^\d+-fix$/.test(name)) ?? '', 'call-2', 'in', 'findings.json'),
        'utf8',
      ),
    );
    expect(findings.findings).toEqual([
      {
        id: 'C2-1',
        source: 'checks',
        severity: 'high',
        file: '',
        title: 'Check verify fails',
        detail: '(fail) a timing test\n 1 fail',
      },
    ]);
    expect(readEvents(dir).filter((event) => event.type === 'codehost:checks_rerun')).toHaveLength(1);
    const pr = await pullRequest(repo);
    expect(pr.comments.at(-1)).toBe(
      '## sail review\n\nMerged after the review:\n\n- reran verify once: still red\n- fixed the failed checks verify in 3 commits\n',
    );
  });
}, 120_000);

test('a merge the host rejects after the base moved merges the base in, then validate, push and merge again', async () => {
  await withTempRepo(async (repo) => {
    setUp(repo, seed());
    const moved = moveBase(repo, 'other.txt', 'from the base\n');
    editPullRequest(repo, { merges: ['rejected', 'merged'] });
    const { code, stderr, keys } = await review(repo);
    expect({ code, stderr }).toEqual({ code: 0, stderr: '' });

    expect(landing(keys)).toEqual(['merge#1', 'sync-base#1', 'validate#3', 'push#2', 'merge#2']);
    const pr = await pullRequest(repo);
    expect(repo.git('log', '-1', '--format=%P', pr.headSha).trim().split(' ')).toContain(moved);
    expect(pr.comments.at(-1)).toBe('## sail review\n\nMerged after the review:\n\n- merged the base in\n');
  });
}, 120_000);

test('a base that conflicts is caught before any check is read and goes to resolve-conflicts, and a head still conflicting after it is caught again by the next merge', async () => {
  await withTempRepo(async (repo) => {
    setUp(repo, seed());
    moveBase(repo, 'notes.txt', 'the base wrote here\n');
    // The fake agent answers that it resolved the conflict without touching the workspace, so the head never takes
    // the base: each merge's probe finds the conflict, with no rejection by the host, until the passes run out.
    const { code, keys, dir } = await review(repo);
    expect(code).not.toBe(0);

    expect(landing(keys)).toEqual([
      'merge#1',
      'sync-base#1',
      'resolve-conflicts#1',
      'validate#3',
      'push#2',
      'merge#2',
      'sync-base#2',
      'resolve-conflicts#2',
      'validate#4',
      'push#3',
      'merge#3',
    ]);
    expect(readEvents(dir).filter((event) => event.type === 'codehost:checks')).toEqual([]);
    expect((await pullRequest(repo)).comments.at(-1)).toBe(
      '## sail review\n\nNot merged: it conflicts with its base in notes.txt\n\nBefore that, the review:\n\n- merged the base in, resolving conflicts in notes.txt\n- merged the base in, resolving conflicts in notes.txt\n\nThe `factory` label is off and `needs-human` is on: this pull request needs a human.\n',
    );
  });
}, 120_000);

test('a red check whose base has moved merges the base in before the fix, so the fix is pushed on the current base', async () => {
  await withTempRepo(async (repo) => {
    setUp(repo, seed());
    const moved = moveBase(repo, 'other.txt', 'from the base\n');
    // The push moves the head, so the fake's checks start again and stay red: the passes run out after the first.
    editPullRequest(repo, { checks: [{ name: 'verify', statuses: ['failed'], log: 'boom' }] });
    const { code, keys } = await review(repo);
    expect(code).not.toBe(0);

    expect(landing(keys).slice(0, 6)).toEqual(['merge#1', 'sync-base#1', 'fix#2', 'validate#3', 'push#2', 'merge#2']);
    const pr = await pullRequest(repo);
    expect(repo.git('log', '-1', '--format=%P', pr.headSha).trim().split(' ')).toContain(moved);
    expect(pr.comments.at(-1)).toContain(
      '- reran verify once: still red\n- merged the base in\n- fixed the failed checks verify in 3 commits\n',
    );
  });
}, 120_000);

test('landing shares the three fix passes: after two review rounds, one fix for the failed checks is left, then the merge fails and hands the pull request to a human', async () => {
  await withTempRepo(async (repo) => {
    setUp(repo);
    editPullRequest(repo, { checks: [{ name: 'verify', statuses: ['failed'], log: 'boom' }] });
    const { code, keys } = await review(repo);
    expect(code).not.toBe(0);

    expect(keys.filter((key) => key.startsWith('fix#'))).toEqual(['fix#1', 'fix#2', 'fix#3']);
    expect(landing(keys)).toEqual(['merge#1', 'sync-base#1', 'fix#3', 'validate#4', 'push#2', 'merge#2']);
    const pr = await pullRequest(repo);
    expect(pr.labels).not.toContain('factory');
    expect(pr.labels).toContain('needs-human');
    expect(pr.comments.at(-1)).toBe(
      '## sail review\n\nNot merged: checks failed: verify\n\nBefore that, the review:\n\n- reran verify once: still red\n- fixed the failed checks verify in 3 commits\n- reran verify once\n\nThe `factory` label is off and `needs-human` is on: this pull request needs a human.\n',
    );
  });
}, 120_000);

test('a fix that blocks while landing blocks the next merge, which comments why, takes the label off and fails', async () => {
  await withTempRepo(async (repo) => {
    setUp(repo, seed());
    editPullRequest(repo, { checks: [{ name: 'verify', statuses: ['failed'], log: 'boom' }] });
    const harness = join(repo.dir, '.sail', 'fake', 'harness.json');
    const script = JSON.parse(readFileSync(harness, 'utf8'));
    script['fix#2'] = [{ outcome: 'blocked', reason: 'the failure is in another package', messages: [], turns: 3 }];
    writeFileSync(harness, JSON.stringify(script));
    const { code, keys } = await review(repo);
    expect(code).not.toBe(0);

    expect(landing(keys)).toEqual(['merge#1', 'sync-base#1', 'fix#2', 'merge#2']);
    const pr = await pullRequest(repo);
    expect(pr.labels).not.toContain('factory');
    expect(pr.comments.at(-1)).toStartWith(
      '## sail review\n\nNot merged: fix blocked: the failure is in another package\n',
    );
  });
}, 120_000);

// sail's own `review` workflow, end to end through the CLI on the fakes: `sail '#7' --workflow review` in a temporary
// repository that holds a copy of the repository's own `.sail/`, its ports all fake and, where a case seeds one, a fake
// Jev. The first cases are about check-fix: it runs on every fix pass, a clear yes from Jev included, with Jev's answers as
// its hint, and a regression it reports goes to the next pass. One is about the tickets it files. The
// rest are about landing: a check still red after its rerun goes to fix, a rejected merge merges the base in, and both
// take the fix passes left. Every merge is preceded by gate-files; a gate change is handed to a human instead.
// Triage cases show Jev decisions surviving omissions and judge overrides winning.
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
function setUp(repo: TempRepo, jev?: object, glossary?: string, gateFile = false): void {
  writeOwnSail(repo, jev === undefined ? {} : { jev });
  if (glossary !== undefined) {
    writeFileSync(join(repo.dir, 'CONTEXT.md'), glossary);
    repo.git('add', 'CONTEXT.md');
    repo.git('commit', '-m', 'define vocabulary');
  }
  const base = repo.git('rev-parse', 'HEAD').trim();
  writeFileSync(join(repo.dir, 'notes.txt'), 'a change\n');
  repo.git('add', 'notes.txt');
  if (gateFile) {
    writeFileSync(join(repo.dir, 'bunfig.toml'), '# a gate change\n');
    repo.git('add', 'bunfig.toml');
  }
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

/** Seeds `check-fix#1` with the fake's every-target-resolved answers, and `extra` targets resolved too, so the fix loop ends after one round. */
function oneRound(repo: TempRepo, extra: string[] = []): void {
  const sail = join(repo.dir, '.sail');
  const seeds = JSON.parse(readFileSync(join(sail, 'fake', 'harness.json'), 'utf8'));
  const [answer] = seeds['check-fix'];
  for (const finding of extra) answer.output.items.push({ finding, resolved: true, detail: 'Holds.' });
  seedHarness(sail, 'check-fix#1', [answer]);
}

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

test('a banned-words Jev hit reaches the judge as B1', async () => {
  await withTempRepo(async (repo) => {
    const answers = seed() as { answers: Record<string, unknown> };
    answers.answers['word-1'] = { type: 'noul', noul: 0.97 };
    setUp(repo, answers, '**Edit**:\nAn alteration.\n_Avoid_: change\n');
    const sail = join(repo.dir, '.sail');
    const [answer] = JSON.parse(readFileSync(join(sail, 'fake', 'harness.json'), 'utf8')).judge;
    answer.output.decisions.push({
      finding: 'B1',
      verdict: 'drop',
      rationale: 'The planted word is harmless.',
      ticket: null,
    });
    seedHarness(sail, 'judge', [answer]);
    const { code, dir } = await review(repo);
    expect(code).toBe(0);
    const folder = readdirSync(dir).find((name) => name.endsWith('-judge'));
    const input = JSON.parse(readFileSync(join(dir, folder ?? '', 'call-1', 'in', 'findings.json'), 'utf8'));
    expect(input.findings).toContainEqual({
      id: 'B1',
      source: 'banned-words',
      severity: 'medium',
      file: 'notes.txt:1',
      title: 'Avoided word "change": use Edit',
      detail:
        'notes.txt:1 uses "change", which CONTEXT.md\'s Edit entry lists under _Avoid_. Jev answers yes at 0.97 (hit from 0.8). Use Edit.',
    });
    expect(asked(dir, 'banned-words#1')).toHaveLength(1);
  });
}, 120_000);

test.each([
  [
    'question cap',
    Array.from({ length: 65 }, (_, i) => `**Edit ${i}**:\nAn alteration.\n_Avoid_: change\n`).join(''),
    '1 candidates omitted',
  ],
  ['oversized candidate', `**Edit**:\n${'x'.repeat(70_000)}\n_Avoid_: change\n`, '1 candidates omitted'],
])(
  'the review comment discloses banned-words omissions from %s',
  async (_name, glossary, note) => {
    await withTempRepo(async (repo) => {
      const answers = seed() as { answers: Record<string, unknown> };
      for (let i = 1; i <= 64; i++) answers.answers[`word-${i}`] = { type: 'noul', noul: 0.05 };
      setUp(repo, answers, glossary);
      const { code } = await review(repo);
      expect(code).toBe(0);
      const pr = await pullRequest(repo);
      expect(pr.comments.find((body) => body.includes('## sail review'))).toContain(
        `Banned-words check incomplete: ${note} (request limits)`,
      );
    });
  },
  120_000,
);

type TriageHint = {
  decided: { finding: string; verdict: string; rationale: string }[];
  answers: { id: string; supported: number; verdict: string; confidence: number }[];
  judge: string[];
};

function callInput(dir: string, stage: string, name: string) {
  const folder = readdirSync(dir).find((entry) => entry.endsWith(`-${stage}`));
  return JSON.parse(readFileSync(join(dir, folder ?? '', 'call-1', 'in', `${name}.json`), 'utf8'));
}

const choice = (verdict: string) => ({ type: 'choice', choice: verdict, confidence: 0.95 });

test.each([
  ['jev-triage runs before the judge and a clear drop the judge omits stays dropped', false],
  ['a clear fix the judge omits becomes a fix target', false],
  ['the judge overrules a Jev-decided finding', true],
  ["a high finding Jev would drop routes on the judge's verdict", true],
])(
  '%s',
  async (_name, overrule) => {
    await withTempRepo(async (repo) => {
      const baseSeed = seed() as { answers: Record<string, object> };
      for (const [id, supported, verdict] of [
        ['R1', 0.97, 'fix'],
        ['R2', 0.97, 'drop'],
        ['R3', 0.6, 'drop'],
        ['R4', 0.97, 'drop'],
      ] as const) {
        baseSeed.answers[`${id}:supported`] = { type: 'noul', noul: supported };
        baseSeed.answers[`${id}:verdict`] = choice(verdict);
      }
      setUp(repo, baseSeed);
      const sail = join(repo.dir, '.sail');
      const harness = JSON.parse(readFileSync(join(sail, 'fake/harness.json'), 'utf8'));
      for (const stage of ['review-requirements', 'review-bugs', 'review-conventions']) {
        const answer = harness[stage][0];
        for (const finding of answer.output.findings) finding.file = 'notes.txt:1';
        seedHarness(sail, stage, [answer]);
      }
      const answer = harness.judge[0];
      answer.output.decisions = answer.output.decisions.filter(
        (d: { finding: string }) => d.finding !== 'R4' && (overrule || d.finding !== 'R1'),
      );
      for (const decision of answer.output.decisions) {
        if (decision.finding === 'R1' || decision.finding === 'R3')
          Object.assign(decision, { verdict: 'drop', ticket: null });
      }
      seedHarness(sail, 'judge', [answer]);
      oneRound(repo, overrule ? [] : ['R1']);
      const { code, keys, dir } = await review(repo);
      expect(code).toBe(0);
      expect(keys.slice(keys.indexOf('judge#1') - 1, keys.indexOf('judge#1') + 1)).toEqual(['jev-triage#1', 'judge#1']);
      const triage = callInput(dir, 'judge', 'triage') as TriageHint;
      expect(triage.decided.map((d) => [d.finding, d.verdict])).toEqual([
        ['R1', 'fix'],
        ['R4', 'drop'],
      ]);
      expect(triage.answers).toEqual([
        { id: 'R1', supported: 0.97, verdict: 'fix', confidence: 0.95 },
        { id: 'R2', supported: 0.97, verdict: 'drop', confidence: 0.95 },
        { id: 'R3', supported: 0.6, verdict: 'drop', confidence: 0.95 },
        { id: 'R4', supported: 0.97, verdict: 'drop', confidence: 0.95 },
      ]);
      expect(triage.judge).toEqual(['V1', 'D1', 'R2', 'R3']);
      expect(triage.decided.every((d) => d.rationale.includes('Jev'))).toBe(true);
      expect(callInput(dir, 'fix', 'findings').findings.map((f: { id: string }) => f.id)).toEqual(
        overrule ? ['V1', 'D1', 'R2'] : ['V1', 'D1', 'R1', 'R2'],
      );
      const decisions = callInput(dir, 'report', 'record').judgement.decisions;
      expect(decisions.find((d: { finding: string }) => d.finding === 'R4')).toEqual({
        finding: 'R4',
        verdict: 'drop',
        rationale: 'Jev: supported at 0.97 (clear from 0.9), drop at 0.95 (clear from 0.9).',
        ticket: null,
      });
      expect(decisions.find((d: { finding: string }) => d.finding === 'R1').verdict).toBe(overrule ? 'drop' : 'fix');
      expect(asked(dir, 'jev-triage#1')).toHaveLength(1);
      expect((await pullRequest(repo)).comments.join('\n')).toContain('R4');
    });
  },
  120_000,
);

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
    expect(asked(dir, 'banned-words#1')).toEqual([]);
  });
}, 120_000);

test('with Jev answering every targeted finding a clear yes, check-fix#1 still runs beside validate#2 with the answers as its hint, and the fix loop ends after one round', async () => {
  await withTempRepo(async (repo) => {
    setUp(repo, seed());
    oneRound(repo);
    const { code, stderr, keys, dir } = await review(repo);
    expect({ code, stderr }).toEqual({ code: 0, stderr: '' });

    expect(keys).toContain('check-fix#1');
    expect(keys.filter((key) => key.startsWith('fix#'))).toEqual(['fix#1']);
    const at = keys.indexOf('jev-fix#1');
    expect(keys.slice(at - 1, at + 1)).toEqual(['fix#1', 'jev-fix#1']);
    expect(keys).toContain('validate#2');
    expect(jevHint(dir, 'check-fix', 1).answers).toEqual([
      { id: 'V1', yes: 0.99 },
      { id: 'D1', yes: 0.99 },
      { id: 'R2', yes: 0.99 },
    ]);
    expect(asked(dir, 'jev-fix#1')).toHaveLength(1);
    const summary = JSON.parse(readFileSync(join(dir, 'summary.json'), 'utf8')) as Summary;
    expect(summary.loops?.fix?.iterations).toBe(1);
  });
}, 120_000);

test('with Jev clearing every target, a medium regression check-fix reports goes to fix#2 as F1-1, and a low one does not', async () => {
  await withTempRepo(async (repo) => {
    setUp(repo, seed());
    const sail = join(repo.dir, '.sail');
    const seeds = JSON.parse(readFileSync(join(sail, 'fake', 'harness.json'), 'utf8'));
    const [resolved] = seeds['check-fix'];
    const regressed = structuredClone(resolved);
    regressed.output.findings = [
      { severity: 'medium', file: 'notes.txt', title: 'the fix broke the footer', detail: 'x' },
      { severity: 'low', file: 'notes.txt', title: 'a stray space', detail: 'y' },
    ];
    seedHarness(sail, 'check-fix#1', [regressed]);
    const again = structuredClone(resolved);
    again.output.items.push({ finding: 'F1-1', resolved: true, detail: 'Holds.' });
    seedHarness(sail, 'check-fix#2', [again]);
    const { code, stderr, keys, dir } = await review(repo);
    expect({ code, stderr }).toEqual({ code: 0, stderr: '' });

    expect(keys.filter((key) => key.startsWith('fix#'))).toEqual(['fix#1', 'fix#2']);
    const folder = readdirSync(dir).find((name) => /^\d+-fix$/.test(name)) ?? '';
    const input = JSON.parse(readFileSync(join(dir, folder, 'call-2', 'in', 'findings.json'), 'utf8'));
    const fresh = input.findings.filter((finding: { id: string }) => finding.id.startsWith('F'));
    expect(fresh).toEqual([
      expect.objectContaining({ id: 'F1-1', source: 'check-fix', title: 'the fix broke the footer' }),
    ]);
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

test('a pull request that changes a gate file is handed to a human before any merge', async () => {
  await withTempRepo(async (repo) => {
    const answers = seed() as { answers: Record<string, unknown> };
    answers.answers['leak-3'] = { type: 'noul', noul: 0 };
    setUp(repo, answers, undefined, true);
    const { code, keys } = await review(repo);
    expect(code).toBe(1);
    expect(keys.filter((key) => key.startsWith('merge#'))).toEqual([]);
    expect(keys.slice(-2)).toEqual(['gate-files#1', 'hand-over#1']);
    const pr = await pullRequest(repo);
    expect(pr.labels.includes('factory')).toBe(false);
    expect(pr.labels.includes('needs-human')).toBe(true);
    expect(pr.comments.at(-1)).toContain(
      'The review stopped: the pull request changes gate files: bunfig.toml; a person merges it',
    );
  });
}, 120_000);

test('a check still red after its rerun goes to fix as a finding, then validate, push and merge again', async () => {
  await withTempRepo(async (repo) => {
    setUp(repo, seed());
    oneRound(repo);
    editPullRequest(repo, {
      checks: [{ name: 'verify', statuses: ['failed', 'failed', 'passed'], log: '(fail) a timing test\n 1 fail' }],
    });
    const { code, stderr, keys, dir } = await review(repo);
    expect({ code, stderr }).toEqual({ code: 0, stderr: '' });

    expect(keys.slice(keys.indexOf('merge#1') - 1, keys.indexOf('merge#1') + 1)).toEqual(['gate-files#1', 'merge#1']);
    expect(landing(keys)).toEqual([
      'merge#1',
      'sync-base#1',
      'fix#2',
      'validate#3',
      'push#2',
      'gate-files#2',
      'merge#2',
    ]);
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
    oneRound(repo);
    const moved = moveBase(repo, 'other.txt', 'from the base\n');
    editPullRequest(repo, { merges: ['rejected', 'merged'] });
    const { code, stderr, keys } = await review(repo);
    expect({ code, stderr }).toEqual({ code: 0, stderr: '' });

    expect(landing(keys)).toEqual(['merge#1', 'sync-base#1', 'validate#3', 'push#2', 'gate-files#2', 'merge#2']);
    const pr = await pullRequest(repo);
    expect(repo.git('log', '-1', '--format=%P', pr.headSha).trim().split(' ')).toContain(moved);
    expect(pr.comments.at(-1)).toBe('## sail review\n\nMerged after the review:\n\n- merged the base in\n');
  });
}, 120_000);

test('a base that conflicts is caught before any check is read and goes to resolve-conflicts, and a head still conflicting after it is caught again by the next merge', async () => {
  await withTempRepo(async (repo) => {
    setUp(repo, seed());
    oneRound(repo);
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
      'gate-files#2',
      'merge#2',
      'sync-base#2',
      'resolve-conflicts#2',
      'validate#4',
      'push#3',
      'gate-files#3',
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
    oneRound(repo);
    const moved = moveBase(repo, 'other.txt', 'from the base\n');
    // The push moves the head, so the fake's checks start again and stay red: the passes run out after the first.
    editPullRequest(repo, { checks: [{ name: 'verify', statuses: ['failed'], log: 'boom' }] });
    const { code, keys } = await review(repo);
    expect(code).not.toBe(0);

    expect(landing(keys).slice(0, 7)).toEqual([
      'merge#1',
      'sync-base#1',
      'fix#2',
      'validate#3',
      'push#2',
      'gate-files#2',
      'merge#2',
    ]);
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
    expect(landing(keys)).toEqual([
      'merge#1',
      'sync-base#1',
      'fix#3',
      'validate#4',
      'push#2',
      'gate-files#2',
      'merge#2',
    ]);
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
    oneRound(repo);
    editPullRequest(repo, { checks: [{ name: 'verify', statuses: ['failed'], log: 'boom' }] });
    const harness = join(repo.dir, '.sail', 'fake', 'harness.json');
    const script = JSON.parse(readFileSync(harness, 'utf8'));
    script['fix#2'] = [{ outcome: 'blocked', reason: 'the failure is in another package', messages: [], turns: 3 }];
    writeFileSync(harness, JSON.stringify(script));
    const { code, keys } = await review(repo);
    expect(code).not.toBe(0);

    expect(landing(keys)).toEqual(['merge#1', 'sync-base#1', 'fix#2', 'gate-files#2', 'merge#2']);
    const pr = await pullRequest(repo);
    expect(pr.labels).not.toContain('factory');
    expect(pr.comments.at(-1)).toStartWith(
      '## sail review\n\nNot merged: fix blocked: the failure is in another package\n',
    );
  });
}, 120_000);

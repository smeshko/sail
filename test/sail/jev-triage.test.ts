// Review triage helpers and the script stage on the fake Jev.
import { expect, test } from 'bun:test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { writeOwnSail } from '../helpers/own-sail';
import { withTempRepo } from '../helpers/temp-repo';

const ROOT = join(import.meta.dir, '../..');
const lib = await import(join(ROOT, '.sail/lib/jev-check.mjs'));
const H1 = '@@ -1 +1 @@\n-old\n+new\n';
const H2 = '@@ -9,2 +9,2 @@\n same\n+next\n';
const DIFF = `diff --git a/notes.txt b/notes.txt\n--- a/notes.txt\n+++ b/notes.txt\n${H1}${H2}`;
const finding = (id = 'R1', severity = 'medium', source = 'bugs', file = 'notes.txt:1') => ({
  id,
  severity,
  source,
  file,
  title: 'claim',
  detail: 'detail',
});

test('citedHunks picks the hunk holding the cited line', () => {
  expect(lib.citedHunks(DIFF, 'notes.txt:1')).toBe(H1);
  expect(lib.citedHunks(DIFF, 'notes.txt:10')).toBe(H2);
  expect(lib.citedHunks(DIFF, 'notes.txt:11')).toBe(H1 + H2);
  expect(lib.citedHunks(DIFF, 'notes.txt')).toBe(H1 + H2);
  expect(lib.citedHunks(DIFF, 'other.ts')).toBe('');
  expect(lib.citedHunks(DIFF, '')).toBe('');
  expect(lib.citedHunks('+++ /dev/null\n@@ -1 +0,0 @@\n-old\n', 'notes.txt')).toBe('');
});

test('citedHunks keeps header-like content and later hunks in the cited file', () => {
  const removedComment = '@@ -1,2 +1 @@\n--- old comment\n-select 1;\n+select 2;\n';
  const addedIncrement = '@@ -5 +4,2 @@\n value\n+++ x\n';
  const later = '@@ -9 +9 @@\n-before\n+after\n';
  const other = 'diff --git a/other.txt b/other.txt\n--- a/other.txt\n+++ b/other.txt\n@@ -0,0 +1 @@\n+other\n';
  const diff = `diff --git a/query.sql b/query.sql\n--- a/query.sql\n+++ b/query.sql\n${removedComment}${addedIncrement}${later}${other}`;
  expect(lib.citedHunks(diff, 'query.sql:1')).toBe(removedComment);
  expect(lib.citedHunks(diff, 'query.sql:5')).toBe(addedIncrement);
  expect(lib.citedHunks(diff, 'query.sql:9')).toBe(later);
  expect(lib.citedHunks(diff, 'query.sql')).toBe(removedComment + addedIncrement + later);
  expect(lib.citedHunks(diff, 'other.txt:1')).toBe('@@ -0,0 +1 @@\n+other\n');
});

test('triageQuestions asks a noul and a choice per finding', () => {
  const q = lib.triageQuestions(['R1', 'R2']);
  expect(Object.keys(q)).toEqual(['R1:supported', 'R1:verdict', 'R2:supported', 'R2:verdict']);
  expect(q['R1:supported'].type).toBe('noul');
  expect(q['R1:verdict'].type).toBe('choice');
  expect(Object.keys(q['R1:verdict'].criteria)).toEqual(['fix', 'ticket', 'drop']);
});

test.each([
  [0.9, 'fix', 0.9, 'fix'],
  [0.9, 'drop', 0.9, 'drop'],
  [0.1, 'drop', 0.9, 'drop'],
  [0.1001, 'drop', 0.9, null],
  [0.8999, 'fix', 0.9, null],
  [0.97, 'drop', 0.8999, null],
  [0.05, 'fix', 0.95, null],
  [0.97, 'ticket', 0.95, null],
])('triageVerdict at supported %s verdict %s confidence %s returns %s', (supported, verdict, confidence, expected) => {
  expect(lib.triageVerdict(finding(), { supported, verdict, confidence })).toBe(expected);
});

test('missing answers stay with the judge and record probabilities supply confidence', () => {
  expect(lib.triageVerdict(finding(), undefined)).toBeNull();
  expect(
    lib.triageAnswers(
      {
        'R1:supported': { type: 'noul', noul: 0.97 },
        'R1:verdict': {
          type: 'choice',
          choice: 'drop',
          probabilities: { drop: 0.96 },
        },
      },
      ['R1', 'R2'],
    ),
  ).toEqual([{ id: 'R1', supported: 0.97, verdict: 'drop', confidence: 0.96 }]);
});

test.each(['validate', 'leak-check', 'demonstrate', 'checks'])('%s always stops merge', (source) => {
  expect(
    lib.triageVerdict(finding('R1', 'low', source), { supported: 0.97, verdict: 'drop', confidence: 0.95 }),
  ).toBeNull();
});

async function stageCase(findings: ReturnType<typeof finding>[], supported = 0.97, verdict = 'drop', jev = true) {
  return withTempRepo(async (repo) => {
    const answers = Object.fromEntries(
      findings.flatMap(({ id }) => [
        [`${id}:supported`, { type: 'noul', noul: supported }],
        [`${id}:verdict`, { type: 'choice', choice: verdict, confidence: 0.95 }],
      ]),
    );
    writeOwnSail(repo, jev ? { jev: { answers } } : {});
    const out = join(repo.home, 'out');
    mkdirSync(out);
    const input = join(repo.home, 'findings.json');
    const diff = join(repo.home, 'diff.patch');
    writeFileSync(input, JSON.stringify({ findings }));
    writeFileSync(diff, DIFF);
    const child = Bun.spawnSync(['bash', join(repo.dir, '.sail/workflows/review/stages/11-jev-triage/run.sh')], {
      cwd: repo.dir,
      env: {
        ...repo.env,
        PATH: `${join(ROOT, 'bin')}:${repo.env.PATH}`,
        SAIL_BUN: process.execPath,
        SAIL_CONFIG: join(repo.dir, '.sail/project.yaml'),
        INPUT_FINDINGS: input,
        INPUT_DIFF: diff,
        STAGE_OUT: out,
      },
    });
    expect(child.exitCode).toBe(0);
    return {
      output: JSON.parse(child.stdout.toString()),
      request:
        jev && findings.some((f) => f.file === 'notes.txt:1')
          ? JSON.parse(readFileSync(join(out, 'jev-request.json'), 'utf8'))
          : null,
    };
  });
}

test('a clear drop is decided by Jev', async () => {
  const { output, request } = await stageCase([finding(), finding('R2')]);
  expect(output.decided).toEqual(
    ['R1', 'R2'].map((id) => ({
      finding: id,
      verdict: 'drop',
      rationale: 'Jev: supported at 0.97 (clear from 0.9), drop at 0.95 (clear from 0.9).',
    })),
  );
  expect(output.judge).toEqual([]);
  expect(Object.keys(request.questions)).toEqual(['R1:supported', 'R1:verdict', 'R2:supported', 'R2:verdict']);
});
test('a clear fix is decided by Jev', async () => {
  expect((await stageCase([finding()], 0.97, 'fix')).output.decided[0].verdict).toBe('fix');
});
test.each([
  [0.6, 'drop'],
  [0.97, 'ticket'],
  [0.05, 'fix'],
])('an unclear finding goes to the judge (%s, %s)', async (supported, verdict) => {
  const { output } = await stageCase([finding()], supported, verdict);
  expect(output.decided).toEqual([]);
  expect(output.judge).toEqual(['R1']);
});
test('a merge-stopping finding goes to the judge whatever Jev answers', async () => {
  const { output } = await stageCase([finding('R1', 'high'), finding('V1', 'medium', 'validate')]);
  expect(output.decided).toEqual([]);
  expect(output.judge).toEqual(['R1', 'V1']);
  expect(output.answers).toEqual(
    ['R1', 'V1'].map((id) => ({ id, supported: 0.97, verdict: 'drop', confidence: 0.95 })),
  );
});
test('a finding citing no hunk is not asked', async () => {
  const { output } = await stageCase([finding('R1', 'medium', 'bugs', 'other.ts')]);
  expect([output.asked, output.decided, output.judge]).toEqual([false, [], ['R1']]);
});
test('with no adapters.jev every finding goes to the judge', async () => {
  const { output } = await stageCase([finding()], 0.97, 'drop', false);
  expect([output.asked, output.decided, output.judge]).toEqual([false, [], ['R1']]);
  expect(output.note.length).toBeGreaterThan(0);
});

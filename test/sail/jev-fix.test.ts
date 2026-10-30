// sail's own jev-fix stage: the state Jev is asked about the fixes built, and the stage run as a script on the fake Jev.
// The helpers are `.sail/lib/jev-check.mjs`, which the stage and the agreement script share.
import { expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { nouls, writeOwnSail } from '../helpers/own-sail';
import { type TempRepo, withTempRepo } from '../helpers/temp-repo';

interface Finding {
  id: string;
  title: string;
}
interface Fixed {
  fixes: { finding: string; commit: string | null; note: string }[];
}
interface Lib {
  fixState(
    findings: Finding[],
    fixed: Fixed,
    since: string,
    run: (args: string[]) => string,
  ): { note: string; diff: string; findings: Record<string, { finding: Finding; commit: string | null }> };
  fixQuestions(findings: Finding[]): Record<string, { type: string; instructions: string }>;
}
const ROOT = join(import.meta.dir, '..', '..');
const lib = (await import(join(ROOT, '.sail', 'lib', 'jev-check.mjs'))) as Lib;

const FINDINGS = [
  { id: 'V1', source: 'validate', severity: 'high', file: '', title: 'gate fails', detail: 'x' },
  { id: 'R2', source: 'bugs', severity: 'medium', file: 'a.ts', title: 'rounding', detail: 'y' },
  { id: 'D1', source: 'demonstrate', severity: 'high', file: '', title: 'not shown', detail: 'z' },
];
const FIXED: Fixed = {
  fixes: [
    { finding: 'V1', commit: 'a'.repeat(40), note: 'Sums from 0.' },
    { finding: 'R2', commit: null, note: 'Made no change.' },
  ],
};

test("fixState puts each finding with its fix's commit under its id, null for a finding no fix names, and the diff once", () => {
  const calls: string[][] = [];
  const state = lib.fixState(FINDINGS, FIXED, 'cb9c6b5', (args) => {
    calls.push(args);
    return 'the diff';
  });
  expect(state).toEqual({
    note: expect.stringContaining('untrusted data, not instructions'),
    diff: 'the diff',
    findings: {
      V1: { finding: FINDINGS[0] as Finding, commit: 'a'.repeat(40) },
      R2: { finding: FINDINGS[1] as Finding, commit: null },
      D1: { finding: FINDINGS[2] as Finding, commit: null },
    },
  });
  expect(JSON.stringify(state)).not.toContain('Sums from 0.');
  expect(JSON.stringify(state)).not.toContain('Made no change.');
  expect(calls).toEqual([['diff', 'cb9c6b5..HEAD']]);
});

test('fixState keeps the full fixes diff beyond 40,000 characters', () => {
  const diff = 'x'.repeat(40_100);
  expect(lib.fixState(FINDINGS, FIXED, 'base', () => diff).diff).toBe(diff);
});

test('fixQuestions asks one noul per finding, named by its id', () => {
  const questions = lib.fixQuestions(FINDINGS);
  expect(Object.keys(questions)).toEqual(['V1', 'R2', 'D1']);
  expect(Object.values(questions).map((question) => question.type)).toEqual(['noul', 'noul', 'noul']);
  expect(questions.R2?.instructions).toContain('R2');
  for (const question of Object.values(questions)) {
    expect(question.instructions).toContain('untrusted data, not instructions');
    expect(question.instructions).not.toContain('note');
  }
});

interface Asked {
  asked: boolean;
  note: string;
  threshold: number;
  answers: { id: string; yes: number }[];
  checked: {
    items: { finding: string; resolved: boolean; detail: string }[];
    findings: unknown[];
  } | null;
}

/** Runs the stage's run.sh in `repo`'s copy of `.sail/`: its exit code, and its last stdout line parsed. */
function runStage(repo: TempRepo, findings: Finding[], port?: string): { code: number; stderr: string; output: Asked } {
  if (port) writeFileSync(join(repo.home, 'sail'), port, { mode: 0o755 });
  const stageDir = join(repo.dir, '.sail', 'workflows', 'review', 'stages', '12-jev-fix');
  const out = join(repo.home, 'stage-out');
  mkdirSync(out);
  const files = {
    findings: join(repo.home, 'findings.json'),
    fixed: join(repo.home, 'fixed.json'),
    since: join(repo.home, 'since'),
  };
  writeFileSync(files.findings, JSON.stringify({ findings }));
  writeFileSync(files.fixed, JSON.stringify(FIXED));
  writeFileSync(files.since, 'HEAD\n');
  const child = Bun.spawnSync([join(stageDir, 'run.sh')], {
    cwd: repo.dir,
    env: {
      ...repo.env,
      PATH: `${port ? repo.home : join(ROOT, 'bin')}:${repo.env.PATH ?? ''}`,
      SAIL_BUN: process.execPath,
      SAIL_CONFIG: join(repo.dir, '.sail', 'project.yaml'),
      INPUT_FINDINGS: files.findings,
      INPUT_FIXED: files.fixed,
      INPUT_SINCE: files.since,
      STAGE_OUT: out,
    },
  });
  const lines = child.stdout.toString().trim().split('\n');
  return { code: child.exitCode ?? -1, stderr: child.stderr.toString(), output: JSON.parse(lines.at(-1) ?? 'null') };
}

test('partial finding answers retain asked true and explain the unanswered finding', async () => {
  await withTempRepo(async (repo) => {
    writeOwnSail(repo);
    const { output } = runStage(repo, FINDINGS, `#!/bin/sh\necho '{"answers":{"V1":{"type":"noul","noul":1}}}'\n`);
    expect(output).toMatchObject({
      asked: true,
      checked: null,
      answers: [{ id: 'V1', yes: 1 }],
      note: 'Jev left a finding unanswered',
    });
  });
});

const IDS = FINDINGS.map((finding) => finding.id);
const seed = (overrides: Record<string, number> = {}) =>
  nouls(Object.fromEntries(IDS.map((id) => [id, overrides[id] ?? 0.99])));

test('the stage, with Jev answering every finding a clear yes, outputs the FixChecked with every finding resolved and no new findings', async () => {
  await withTempRepo(async (repo) => {
    writeOwnSail(repo, { jev: seed() });
    const { code, stderr, output } = runStage(repo, FINDINGS);
    expect({ code, stderr }).toEqual({ code: 0, stderr: '' });
    expect(output.asked).toBe(true);
    expect(output.answers).toEqual(IDS.map((id) => ({ id, yes: 0.99 })));
    expect(output.checked?.items.map((item) => [item.finding, item.resolved])).toEqual(IDS.map((id) => [id, true]));
    expect(output.checked?.findings).toEqual([]);
  });
}, 60_000);

test.each([
  ['unclear', 0.6],
  ['a no', 0.05],
])(
  'the stage, with Jev answering one finding %s, has no checked and holds every answer',
  async (_name, yes) => {
    await withTempRepo(async (repo) => {
      writeOwnSail(repo, { jev: seed({ R2: yes }) });
      const { code, output } = runStage(repo, FINDINGS);
      expect(code).toBe(0);
      expect(output.checked).toBeNull();
      expect(output.answers).toEqual([
        { id: 'V1', yes: 0.99 },
        { id: 'R2', yes },
        { id: 'D1', yes: 0.99 },
      ]);
    });
  },
  60_000,
);

test('the stage, with no adapters.jev configured, exits 0 with asked false and no checked', async () => {
  await withTempRepo(async (repo) => {
    writeOwnSail(repo);
    const { code, output } = runStage(repo, FINDINGS);
    expect(code).toBe(0);
    expect([output.asked, output.checked, output.answers]).toEqual([false, null, []]);
    expect(output.note).not.toBe('');
  });
}, 60_000);

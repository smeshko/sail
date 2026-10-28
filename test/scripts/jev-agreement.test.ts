// scripts/jev-agreement.ts on a hand-made run directory, with the fake Jev, and sail's own config naming the typesafe Jev.
import { expect, test } from 'bun:test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { collect, table } from '../../scripts/jev-agreement';
import { validateDocument } from '../../src/engine/schemas';
import { nouls, OWN_SAIL, writeOwnSail } from '../helpers/own-sail';
import { type TempRepo, withTempRepo } from '../helpers/temp-repo';

const ROOT = join(import.meta.dir, '..', '..');

const PLAN = [
  '# Plan',
  '',
  '## Tasks',
  '',
  '- [ ] TASK-001: One',
  '- [ ] TASK-002: Two',
  '',
  '## Task details',
  '',
  '### TASK-001: One',
  '',
  'Type: impl',
  '',
  '### TASK-002: Two',
  '',
  'Type: impl',
  '',
].join('\n');

/** A run directory holding one done `check-tasks#1`: TASK-001 implemented, TASK-002 not, at $0.70 and 30 seconds. */
function writeRun(repo: TempRepo): string {
  const runDir = join(repo.home, 'run');
  const call = join(runDir, '04-check-tasks', 'call-1');
  mkdirSync(join(call, 'in'), { recursive: true });
  writeFileSync(join(call, 'in', 'plan.md'), PLAN);
  writeFileSync(join(runDir, 'run.json'), JSON.stringify({ baseSha: repo.git('rev-parse', 'HEAD').trim() }));
  const output = {
    tasks: [
      { id: 'TASK-001', implemented: true, evidence: 'abc1234' },
      { id: 'TASK-002', implemented: false, evidence: 'missing' },
    ],
  };
  writeFileSync(
    join(call, 'result.json'),
    JSON.stringify({
      schema: 'sail.result.v1',
      key: 'check-tasks#1',
      kind: 'agent',
      outcome: 'done',
      output,
      durationMs: 30_000,
      usage: { costUsd: 0.7 },
      workspace: { headSha: repo.git('rev-parse', 'HEAD').trim(), commitsAdded: 0, diffStat: '' },
    }),
  );
  writeFileSync(
    join(runDir, 'journal.ndjson'),
    `${JSON.stringify({
      seq: 1,
      key: 'check-tasks#1',
      stage: 'check-tasks',
      call: 1,
      outcome: 'done',
      output,
      reason: null,
      files: {},
      resultPath: '04-check-tasks/call-1/result.json',
      recordedAt: '2026-01-01T00:00:00.000Z',
    })}\n`,
  );
  return runDir;
}

test('jev-agreement prints agreement 1/2 and one false yes at 0.95 when Jev says yes to the task the agent found not implemented, and the call it would save', async () => {
  await withTempRepo(async (repo) => {
    writeOwnSail(repo, { jev: nouls({ 'TASK-001': 0.99, 'TASK-002': 0.99 }) });
    const runDir = writeRun(repo);
    const child = Bun.spawnSync(['bun', join(ROOT, 'scripts', 'jev-agreement.ts'), runDir], {
      cwd: repo.dir,
      env: {
        ...repo.env,
        PATH: `${join(ROOT, 'bin')}:${repo.env.PATH ?? ''}`,
        SAIL_CONFIG: join(repo.dir, '.sail', 'project.yaml'),
      },
    });
    expect(child.stderr.toString()).toBe('');
    const lines = child.stdout.toString().trimEnd().split('\n');
    expect(lines[0]).toBe('check-tasks: 1 calls, 2 items');
    expect(lines.find((line) => line.includes('0.95'))).toBe(
      '  0.95  agreement 1/2  false yeses 1  false noes 0  skippable 1/1  saves $0.70 and 0.5 min',
    );
    expect(lines).toHaveLength(6);
  });
}, 60_000);

test('collect rebuilds tasks against the recorded base and call head, not live refs', async () => {
  await withTempRepo(async (repo) => {
    const runDir = writeRun(repo);
    const baseSha = 'b'.repeat(40);
    writeFileSync(join(runDir, 'run.json'), JSON.stringify({ baseSha }));
    const lib = (await import(join(ROOT, '.sail/lib/jev-check.mjs'))) as Parameters<typeof collect>[1];
    const args: string[][] = [];
    const notes: string[] = [];
    collect(
      runDir,
      {
        ...lib,
        git: (each) => {
          args.push(each);
          return 'evidence';
        },
        askNouls: () => ({ asked: true, answers: {} }),
      },
      repo.home,
      notes,
    );
    expect(notes).toEqual([]);
    const head = repo.git('rev-parse', 'HEAD').trim();
    expect(args).toEqual([
      ['log', `${baseSha}..${head}`, '--format=%h %s'],
      ['diff', `${baseSha}...${head}`],
    ]);
  });
});

test('check-fix rebuilds recorded findings, fix notes and diff, maps resolved, and reports skipped calls', async () => {
  await withTempRepo(async (repo) => {
    const runDir = writeRun(repo);
    const call = join(runDir, '13-check-fix/call-1');
    mkdirSync(join(call, 'in'), { recursive: true });
    const findings = [
      { id: 'R1', title: 'broken' },
      { id: 'R2', title: 'also broken' },
    ];
    const fixed = { fixes: [{ finding: 'R1', commit: 'fix-sha', note: 'fixed it' }] };
    writeFileSync(join(call, 'in/findings.json'), JSON.stringify({ findings }));
    writeFileSync(join(call, 'in/fixed.json'), JSON.stringify(fixed));
    writeFileSync(join(call, 'in/since'), 'review-sha\n');
    writeFileSync(
      join(call, 'result.json'),
      JSON.stringify({ workspace: { headSha: 'call-sha' }, usage: { costUsd: 2 }, durationMs: 120_000 }),
    );
    const entry = {
      seq: 1,
      key: 'check-fix#1',
      stage: 'check-fix',
      call: 1,
      outcome: 'done',
      output: {
        items: [
          { finding: 'R1', resolved: true },
          { finding: 'R2', resolved: false },
        ],
      },
      reason: null,
      files: {},
      resultPath: '13-check-fix/call-1/result.json',
      recordedAt: '2026-01-01T00:00:00.000Z',
    };
    writeFileSync(join(runDir, 'journal.ndjson'), `${JSON.stringify(entry)}\n`);
    const lib = (await import(join(ROOT, '.sail/lib/jev-check.mjs'))) as Parameters<typeof collect>[1];
    const notes: string[] = [];
    const calls = collect(
      runDir,
      {
        ...lib,
        git: (args) => {
          expect(args).toEqual(['diff', 'review-sha..call-sha']);
          return 'recorded fix diff';
        },
        askNouls: (questions, state) => {
          expect(Object.keys(questions)).toEqual(['R1', 'R2']);
          expect(state).toEqual({
            diff: 'recorded fix diff',
            findings: {
              R1: { finding: findings[0], fix: fixed.fixes[0] },
              R2: { finding: findings[1], fix: null },
            },
          });
          return { asked: true, answers: { R1: { type: 'noul', noul: 0.92 }, R2: { type: 'noul', noul: 0.82 } } };
        },
      },
      repo.home,
      notes,
    );
    expect(calls).toEqual([
      {
        stage: 'check-fix',
        items: [
          { id: 'R1', agent: true, yes: 0.92 },
          { id: 'R2', agent: false, yes: 0.82 },
        ],
        costUsd: 2,
        minutes: 2,
      },
    ]);
    expect(table('check-fix', calls)).toEqual([
      'check-fix: 1 calls, 2 items',
      '  0.80  agreement 1/2  false yeses 1  false noes 0  skippable 1/1  saves $2.00 and 2.0 min',
      '  0.85  agreement 2/2  false yeses 0  false noes 0  skippable 0/1  saves $0.00 and 0.0 min',
      '  0.90  agreement 2/2  false yeses 0  false noes 0  skippable 0/1  saves $0.00 and 0.0 min',
      '  0.95  agreement 1/2  false yeses 0  false noes 1  skippable 0/1  saves $0.00 and 0.0 min',
      '  0.99  agreement 1/2  false yeses 0  false noes 1  skippable 0/1  saves $0.00 and 0.0 min',
    ]);
    expect(notes).toEqual([]);
    expect(
      collect(runDir, { ...lib, git: () => '', askNouls: () => ({ asked: false, note: 'offline' }) }, repo.home, notes),
    ).toEqual([]);
    expect(notes).toEqual([`check-fix#1 in ${runDir}: offline`]);
    writeFileSync(join(call, 'in/findings.json'), 'not JSON');
    expect(collect(runDir, lib, repo.home, notes)).toEqual([]);
    expect(notes).toHaveLength(2);
    expect(notes[1]).toContain(`check-fix#1 in ${runDir}:`);
  });
});

test("sail's own project.yaml, with adapters.jev, validates against sail.project.v1", () => {
  const config = Bun.YAML.parse(readFileSync(join(OWN_SAIL, 'project.yaml'), 'utf8')) as {
    adapters: { jev?: unknown };
  };
  expect(config.adapters.jev).toEqual({ use: 'typesafe' });
  expect(validateDocument('sail.project.v1', config)).toEqual([]);
});

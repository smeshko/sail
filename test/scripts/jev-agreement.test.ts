// scripts/jev-agreement.ts on a hand-made run directory, with the fake Jev, and sail's own config naming the typesafe Jev.
import { expect, test } from 'bun:test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { collect } from '../../scripts/jev-agreement';
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

test("sail's own project.yaml, with adapters.jev, validates against sail.project.v1", () => {
  const config = Bun.YAML.parse(readFileSync(join(OWN_SAIL, 'project.yaml'), 'utf8')) as {
    adapters: { jev?: unknown };
  };
  expect(config.adapters.jev).toEqual({ use: 'typesafe' });
  expect(validateDocument('sail.project.v1', config)).toEqual([]);
});

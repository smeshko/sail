// scripts/jev-agreement.ts on a run directory built from real commits, with the fake Jev, and sail's own config naming the typesafe Jev.
import { expect, test } from 'bun:test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { collect, table } from '../../scripts/jev-agreement';
import { validateDocument, validateRunDir } from '../../src/engine/schemas';
import type { NewEvent } from '../../src/events/types';
import { end, journal, ndjson, RUN_ID, runStart, stamp, start } from '../helpers/events';
import { GOLDEN_RUN } from '../helpers/golden-run';
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

interface Commits {
  base: string;
  first: string;
  second: string;
}

/** Two task commits on a branch off the temp repo's initial commit, then the clone's HEAD back on the base. */
function commitTasks(repo: TempRepo): Commits {
  const base = repo.git('rev-parse', 'HEAD');
  repo.git('checkout', '-b', 'work');
  writeFileSync(join(repo.dir, 'one.txt'), 'one\n');
  repo.git('add', 'one.txt');
  repo.git('commit', '-m', 'task one');
  const first = repo.git('rev-parse', 'HEAD');
  writeFileSync(join(repo.dir, 'two.txt'), 'two\n');
  repo.git('add', 'two.txt');
  repo.git('commit', '-m', 'task two');
  const second = repo.git('rev-parse', 'HEAD');
  repo.git('checkout', 'main');
  return { base, first, second };
}

interface CallSpec {
  key: string;
  output: unknown;
  costUsd?: number;
  durationMs?: number;
  /** Files written under the call's `in/`. */
  inFiles?: Record<string, string>;
}

const STAGE_DIRS: Record<string, string> = {
  implement: '02-implement',
  'check-tasks': '04-check-tasks',
  fix: '12-fix',
  'check-fix': '13-check-fix',
};

/** A run directory in the shape the engine writes, with the given calls journaled in order; its schemas are checked. */
function writeRun(repo: TempRepo, base: string, calls: CallSpec[], options: { workspace?: boolean } = {}): string {
  const runDir = join(repo.home, `run-${Math.random().toString(36).slice(2)}`);
  mkdirSync(runDir, { recursive: true });
  const header = JSON.parse(readFileSync(join(GOLDEN_RUN, 'run.json'), 'utf8'));
  writeFileSync(join(runDir, 'run.json'), JSON.stringify({ ...header, runId: RUN_ID }));
  const golden = JSON.parse(readFileSync(join(GOLDEN_RUN, '02-implement', 'call-1', 'result.json'), 'utf8'));
  const events: [number, NewEvent][] = [[0, runStart()]];
  if (options.workspace !== false) {
    events.push([
      100,
      {
        type: 'workspace:created',
        path: `.sail-runs/${RUN_ID}/workspace`,
        branch: 'sail/FAKE-1-work',
        baseSha: base,
        durationMs: 100,
      },
    ]);
  }
  const journalLines: object[] = [];
  calls.forEach((spec, i) => {
    const [stage, number] = spec.key.split('#') as [string, string];
    const dir = `${STAGE_DIRS[stage]}/call-${number}`;
    const call = join(runDir, dir);
    mkdirSync(join(call, 'in'), { recursive: true });
    for (const [name, text] of Object.entries(spec.inFiles ?? {})) writeFileSync(join(call, 'in', name), text);
    const durationMs = spec.durationMs ?? 1000;
    const result = {
      ...golden,
      runId: RUN_ID,
      stage,
      call: Number(number),
      key: spec.key,
      output: spec.output,
      files: {},
      consumed: {},
      durationMs,
      usage: { ...golden.usage, costUsd: spec.costUsd ?? 0 },
    };
    writeFileSync(join(call, 'result.json'), JSON.stringify(result));
    const ms = 1000 * (i + 1);
    events.push(
      [ms, start(spec.key, { kind: 'agent' })],
      [
        ms + 1,
        {
          ...(end(spec.key, 'done', durationMs) as Extract<NewEvent, { type: 'stage:end' }>),
          resultPath: `${dir}/result.json`,
        },
      ],
      [ms + 2, journal(spec.key, i + 1, 'done')],
    );
    journalLines.push({
      seq: i + 1,
      key: spec.key,
      stage,
      call: Number(number),
      outcome: 'done',
      output: spec.output,
      reason: null,
      files: {},
      resultPath: `${dir}/result.json`,
      recordedAt: '2026-01-01T00:00:00.000Z',
    });
  });
  writeFileSync(join(runDir, 'events.ndjson'), ndjson(stamp(...events)));
  writeFileSync(join(runDir, 'journal.ndjson'), journalLines.map((line) => `${JSON.stringify(line)}\n`).join(''));
  expect(validateRunDir(runDir).issues).toEqual([]);
  return runDir;
}

const implemented = (...commits: (string | null)[]) => ({
  tasks: commits.map((commit, i) => ({ id: `TASK-00${i + 1}`, commit, evidence: 'done' })),
  notes: '',
});

/** TASK-001 implemented, TASK-002 not, at $0.70 and 30 seconds. */
const CHECKED: CallSpec = {
  key: 'check-tasks#1',
  output: {
    tasks: [
      { id: 'TASK-001', implemented: true, evidence: 'abc1234' },
      { id: 'TASK-002', implemented: false, evidence: 'missing' },
    ],
  },
  costUsd: 0.7,
  durationMs: 30_000,
  inFiles: { 'plan.md': PLAN },
};

async function recordGit(runDir: string, repo: TempRepo, notes: string[] = []) {
  const lib = (await import(join(ROOT, '.sail/lib/jev-check.mjs'))) as Parameters<typeof collect>[1];
  const args: string[][] = [];
  const calls = collect(
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
  return { args, calls, notes };
}

test('jev-agreement prints agreement 1/2 and one false yes at 0.95 when Jev says yes to the task the agent found not implemented, and the call it would save', async () => {
  await withTempRepo(async (repo) => {
    writeOwnSail(repo, { jev: nouls({ 'TASK-001': 0.99, 'TASK-002': 0.99 }) });
    const { base, first, second } = commitTasks(repo);
    const runDir = writeRun(repo, base, [{ key: 'implement#1', output: implemented(first, second) }, CHECKED]);
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

test('collect rebuilds tasks against the base of workspace:created and the implement head, not live refs', async () => {
  await withTempRepo(async (repo) => {
    const { base, first, second } = commitTasks(repo);
    const runDir = writeRun(repo, base, [{ key: 'implement#1', output: implemented(first, second) }, CHECKED]);
    const { args, notes } = await recordGit(runDir, repo);
    expect(notes).toEqual([]);
    expect(args).toEqual([
      ['log', `${base}..${second}`, '--format=%h %s'],
      ['diff', `${base}...${second}`],
    ]);
  });
});

test('collect takes the head from the earlier implement call when the nearest one committed nothing', async () => {
  await withTempRepo(async (repo) => {
    const { base, first, second } = commitTasks(repo);
    const runDir = writeRun(repo, base, [
      { key: 'implement#1', output: implemented(first, second) },
      { key: 'implement#2', output: implemented(null, null) },
      CHECKED,
    ]);
    const { args, notes } = await recordGit(runDir, repo);
    expect(notes).toEqual([]);
    expect(args).toEqual([
      ['log', `${base}..${second}`, '--format=%h %s'],
      ['diff', `${base}...${second}`],
    ]);
  });
});

test('collect takes the last implement call before the check, not an implement call after it', async () => {
  await withTempRepo(async (repo) => {
    const { base, first, second } = commitTasks(repo);
    const runDir = writeRun(repo, base, [
      { key: 'implement#1', output: implemented(first, null) },
      CHECKED,
      { key: 'implement#2', output: implemented(first, second) },
    ]);
    const { args } = await recordGit(runDir, repo);
    expect(args[0]).toEqual(['log', `${base}..${first}`, '--format=%h %s']);
  });
});

test('collect notes a run with no workspace:created event and returns no calls', async () => {
  await withTempRepo(async (repo) => {
    const { base, first, second } = commitTasks(repo);
    const runDir = writeRun(repo, base, [{ key: 'implement#1', output: implemented(first, second) }, CHECKED], {
      workspace: false,
    });
    const { args, calls, notes } = await recordGit(runDir, repo);
    expect(calls).toEqual([]);
    expect(args).toEqual([]);
    expect(notes).toEqual([`${runDir}: no workspace:created event`]);
  });
});

test('collect notes a check-tasks call with no implement commit before it and skips it', async () => {
  await withTempRepo(async (repo) => {
    const { base } = commitTasks(repo);
    const runDir = writeRun(repo, base, [{ key: 'implement#1', output: implemented(null, null) }, CHECKED]);
    const { args, calls, notes } = await recordGit(runDir, repo);
    expect(calls).toEqual([]);
    expect(args).toEqual([]);
    expect(notes).toEqual([`check-tasks#1 in ${runDir}: no implement commit before it`]);
  });
});

test('check-fix rebuilds recorded findings, fix commits and diff from the earlier fix call, maps resolved, and reports skipped calls', async () => {
  await withTempRepo(async (repo) => {
    const { base, first, second } = commitTasks(repo);
    const findings = [
      { id: 'R1', title: 'broken' },
      { id: 'R2', title: 'also broken' },
    ];
    const fixed = { fixes: [{ finding: 'R1', commit: second, note: 'fixed it' }] };
    const runDir = writeRun(repo, base, [
      { key: 'fix#1', output: { fixes: [{ finding: 'R1', commit: first, note: 'first try' }] } },
      { key: 'fix#2', output: fixed },
      {
        key: 'check-fix#1',
        output: {
          items: [
            { finding: 'R1', resolved: true },
            { finding: 'R2', resolved: false },
          ],
        },
        costUsd: 2,
        durationMs: 120_000,
        inFiles: {
          'findings.json': JSON.stringify({ findings }),
          'fixed.json': JSON.stringify(fixed),
          since: 'review-sha\n',
        },
      },
    ]);
    const lib = (await import(join(ROOT, '.sail/lib/jev-check.mjs'))) as Parameters<typeof collect>[1];
    const notes: string[] = [];
    const calls = collect(
      runDir,
      {
        ...lib,
        git: (args) => {
          expect(args).toEqual(['diff', `review-sha..${second}`]);
          return 'recorded fix diff';
        },
        askNouls: (questions, state) => {
          expect(Object.keys(questions)).toEqual(['R1', 'R2']);
          expect(state).toEqual({
            note: expect.stringContaining('untrusted data'),
            diff: 'recorded fix diff',
            findings: {
              R1: { finding: findings[0], commit: second },
              R2: { finding: findings[1], commit: null },
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
    writeFileSync(join(runDir, '13-check-fix/call-1/in/findings.json'), 'not JSON');
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

// `sail resume`, in process through run(): a run of the stub repository, interrupted or ended in a repository of its
// own, then copied into the test's repository and resumed there. A process opens one run per .sail/, and Bun caches
// the workflow's modules by path, so the run and its resume never share a .sail/.
import { expect, test } from 'bun:test';
import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { EXIT_FAILED, EXIT_OK, EXIT_REFUSED, EXIT_SUSPENDED } from '../../src/cli/exit-codes';
import { edit } from '../helpers/fixture';
import { fakeInterrupts, normaliseDurations, runCaptured } from '../helpers/run-captured';
import {
  copyRun,
  interruptWhenAsleep,
  type StubOptions,
  setSleepAt,
  swapImplementAndTests,
  writeStub,
} from '../helpers/stub-workflow';
import { withTempRepo } from '../helpers/temp-repo';

const WORKFLOW = 'workflows/ticket-to-pr/workflow.ts';

const runIdIn = (repoDir: string) => readdirSync(join(repoDir, '.sail-runs'))[0] ?? '';

/** `sail run` of the stub in a repository of its own, interrupted during `implement#2`, then copied into `to`. */
function interruptedInto(to: string): Promise<string> {
  return withTempRepo(async (from) => {
    writeStub(from.dir, { sleepAt: 'implement#2' });
    const interrupts = fakeInterrupts();
    await interruptWhenAsleep(from.dir, runCaptured(['run'], from.dir, interrupts), interrupts.interrupt);
    copyRun(from.dir, to);
    return runIdIn(to);
  });
}

/** `sail run` of the stub to its end in a repository of its own, then copied into `to`. */
function endedInto(to: string, options: StubOptions): Promise<string> {
  return withTempRepo(async (from) => {
    writeStub(from.dir, options);
    await runCaptured(['run'], from.dir);
    copyRun(from.dir, to);
    return runIdIn(to);
  });
}

/** Each run's STATUS and journal, by run id: what a refusal must leave as it was. */
function runFiles(repoDir: string): Record<string, string[]> {
  const runs = join(repoDir, '.sail-runs');
  if (!existsSync(runs)) return {};
  return Object.fromEntries(
    readdirSync(runs).map((runId) => [
      runId,
      ['STATUS', 'journal.ndjson'].map((file) => readFileSync(join(runs, runId, file), 'utf8')),
    ]),
  );
}

/** The sum of the `replays` of every `run:end` in the run's events file. */
function replaysOf(repoDir: string, runId: string): number {
  return readFileSync(join(repoDir, '.sail-runs', runId, 'events.ndjson'), 'utf8')
    .trimEnd()
    .split('\n')
    .map((line) => JSON.parse(line) as { type: string; replays?: number })
    .filter((event) => event.type === 'run:end')
    .reduce((sum, event) => sum + (event.replays ?? 0), 0);
}

// biome-ignore format: TDD-PENDING TASK-007
test
  .skip // TDD-PENDING TASK-007
  ('sail resume opens with what already ran, runs the interrupted call as its second try, and ends with the whole run', async () => {
  await withTempRepo(async (repo) => {
    const runId = await interruptedInto(repo.dir);
    const { code, stdout, stderr } = await runCaptured(['resume', runId], repo.dir);
    expect(normaliseDurations(stdout)).toBe(
      [
        `sail · ticket-to-pr v1 · ${runId} · resumed after 3 calls, last tests#1 failed`,
        'fix            ↻ iteration 2/3 · feedback from tests#1',
        'implement#2    ▶ implement · script · try 2',
        'implement#2      exit 0 → passed · <t>',
        'implement#2      output valid',
        'implement#2    ✓ passed · <t>',
        'tests#2        ▶ tests · script',
        'tests#2          exit 0 → passed · <t>',
        'tests#2          output valid',
        'tests#2        ✓ passed · <t>',
        'self-review#1  ▶ self-review · script',
        'self-review#1    exit 0 → passed · <t>',
        'self-review#1    output valid',
        'self-review#1  ✓ passed · <t>',
        'fix            ↻ break after 2/3',
        'publish#1      ▶ publish · script',
        'publish#1        exit 0 → passed · <t>',
        'publish#1        output valid',
        'publish#1      ✓ passed · <t>',
        '',
        'completed · <t>',
        '  calls    7 · 6 passed, 1 failed',
        '  loops    fix 2/3',
        `  replays  ${replaysOf(repo.dir, runId)}`,
        `  run      .sail-runs/${runId}`,
        '',
      ].join('\n'),
    );
    expect(stderr).toBe('');
    expect(code).toBe(EXIT_OK);
  });
}, 30_000);

// biome-ignore format: TDD-PENDING TASK-006
test
  .skip // TDD-PENDING TASK-006
  ('-q with -v is refused with exit 3, and the run is left as it was', async () => {
  await withTempRepo(async (repo) => {
    const runId = await interruptedInto(repo.dir);
    const before = runFiles(repo.dir);
    const { code, stdout, stderr } = await runCaptured(['resume', runId, '-qv'], repo.dir);
    expect({ code, stdout, stderr }).toEqual({
      code: EXIT_REFUSED,
      stdout: '',
      stderr: "sail resume: -q and -v can't be combined\n",
    });
    expect(runFiles(repo.dir)).toEqual(before);
  });
}, 30_000);

type Refusal = (repoDir: string) => Promise<{ argv: string[]; message: string }>;

test.each<[string, Refusal]>([
  [
    'a completed run',
    async (repoDir) => {
      const runId = await endedInto(repoDir, { testsPassAt: 1 });
      return { argv: ['resume', runId], message: `run ${runId} has completed: there is nothing to resume` };
    },
  ],
  [
    'a failed run',
    async (repoDir) => {
      const runId = await endedInto(repoDir, { testsPassAt: 99 });
      return { argv: ['resume', runId], message: `run ${runId} failed (workflow_failed): a failed run is final` };
    },
  ],
  [
    'an id that names no run',
    async (repoDir) => {
      writeStub(repoDir);
      return { argv: ['resume', 'LOCAL-NOPE'], message: "no run 'LOCAL-NOPE' in .sail-runs" };
    },
  ],
  [
    'no run id',
    async (repoDir) => {
      writeStub(repoDir);
      return { argv: ['resume'], message: 'usage: sail resume <run> [--input <json>]' };
    },
  ],
  [
    '--input that is not JSON',
    async (repoDir) => {
      const runId = await interruptedInto(repoDir);
      return { argv: ['resume', runId, '--input', '{'], message: '--input is not JSON: ' };
    },
  ],
  [
    "--input the intake's schema rejects",
    async (repoDir) => {
      const runId = await interruptedInto(repoDir);
      return { argv: ['resume', runId, '--input', '{"x":1}'], message: "the input doesn't match intake 'ticket':" };
    },
  ],
  [
    'a type error in the workflow',
    async (repoDir) => {
      const runId = await interruptedInto(repoDir);
      edit(join(repoDir, '.sail'), WORKFLOW, "{ spec: s.files['spec.md'], feedback: iteration.previous }", '{}');
      return { argv: ['resume', runId], message: '1 type error in .sail/workflows/ticket-to-pr/workflow.ts' };
    },
  ],
  [
    'a workflow that is gone',
    async (repoDir) => {
      const runId = await interruptedInto(repoDir);
      rmSync(join(repoDir, '.sail', 'workflows', 'ticket-to-pr'), { recursive: true });
      return { argv: ['resume', runId], message: "no workflow 'ticket-to-pr'" };
    },
  ],
])(
  '%s is refused with exit 3, and the run is left as it was',
  async (_, prepare) => {
    await withTempRepo(async (repo) => {
      const { argv, message } = await prepare(repo.dir);
      const before = runFiles(repo.dir);
      const { code, stdout, stderr } = await runCaptured(argv, repo.dir);
      expect(stderr).toContain(`sail resume: ${message}`);
      expect(stdout).toBe('');
      expect(runFiles(repo.dir)).toEqual(before);
      expect(code).toBe(EXIT_REFUSED);
    });
  },
  30_000,
);

test('a workflow whose keys no longer fit the journal fails the resume with determinism_violation, and exits 1', async () => {
  await withTempRepo(async (repo) => {
    const runId = await interruptedInto(repo.dir);
    swapImplementAndTests(join(repo.dir, '.sail'));
    const { code, stdout } = await runCaptured(['resume', runId], repo.dir);
    expect(stdout).toContain(
      "determinism_violation: the workflow asked for 'tests#1' where the journal has 'implement#1'",
    );
    expect(code).toBe(EXIT_FAILED);
  });
}, 30_000);

test('Ctrl-C during sail resume suspends the run again, and names the resume again', async () => {
  await withTempRepo(async (repo) => {
    const runId = await interruptedInto(repo.dir);
    setSleepAt(repo.dir, 'implement#2');
    const interrupts = fakeInterrupts();
    const resuming = runCaptured(['resume', runId], repo.dir, interrupts);
    const { end, alive } = await interruptWhenAsleep(repo.dir, resuming, interrupts.interrupt);
    expect(end.stdout).toEndWith(`resume it with: sail resume ${runId}\n`);
    expect(end.code).toBe(EXIT_SUSPENDED);
    expect(alive).toEqual([]);
    expect([interrupts.registered, interrupts.unregistered]).toEqual([1, 1]);
    const tryTwo = join(repo.dir, '.sail-runs', runId, '02-implement', 'call-2', 'try-2', 'result.json');
    expect(existsSync(tryTwo)).toBe(true);
  });
}, 30_000);

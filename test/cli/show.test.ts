// `sail show`, in process through run(): the golden run copied into a temp repository beside a `.sail/` with nothing in
// it, since the command never reads project.yaml, runs written by hand, and stub runs. The golden table is D12's, written
// by hand.
import { expect, test } from 'bun:test';
import { appendFileSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { EXIT_OK, EXIT_REFUSED } from '../../src/cli/exit-codes';
import { runWorkflow } from '../../src/engine/runtime';
import { formatIssue, validateDocument } from '../../src/engine/schemas';
import { end, journal, ndjson, runEnd, runStart, stamp, start } from '../helpers/events';
import { copyGoldenRun, emptySailDir, GOLDEN_RUN_ID } from '../helpers/golden-run';
import { runCaptured } from '../helpers/run-captured';
import { writeStub } from '../helpers/stub-workflow';
import { withTempRepo } from '../helpers/temp-repo';

const text = (...lines: string[]) => lines.map((line) => `${line}\n`).join('');

/** What `sail show` prints for the golden run. */
const GOLDEN = text(
  `${GOLDEN_RUN_ID} · ticket-to-pr@1 · completed · 1m 11s`,
  '',
  'key                   kind    outcome  duration  cost   next',
  'intake#1              script  passed   2.1s',
  'spec#1                agent   done     10.4s     $0.31  implement#1',
  'implement#1           agent   done     12.6s     $0.48  tests#1',
  'tests#1               script  failed   2.5s             implement#2',
  'implement#2           agent   done     12.5s     $0.24  tests#2',
  'tests#2               script  passed   2.7s             self-review#1',
  'self-review#1         agent   done     10.5s     $0.22  publish#1',
  'publish#1                     passed   14.5s     $0.10  end',
  '  publish#1/describe  agent   done     10.4s     $0.10',
  '  publish#1/open      script  passed   3.8s',
  '',
  'loops   fix 2/3',
  'totals  8 calls · 9 steps · 11 tool calls · 1 denial · 8 replays',
  'cost    $1.35 of $25.00 (5.4%)',
);

/** The run's summary.json as written, or '' when it has none. */
const summaryText = (runDir: string): string =>
  existsSync(join(runDir, 'summary.json')) ? readFileSync(join(runDir, 'summary.json'), 'utf8') : '';

/** A copy of the golden run whose events are `events` instead, and which has no summary.json. */
function runWith(repoDir: string, events: string): string {
  const dir = copyGoldenRun(repoDir);
  writeFileSync(join(dir, 'events.ndjson'), events);
  rmSync(join(dir, 'summary.json'));
  return dir;
}

/** A stub run of ticket-to-pr in `repoDir`, to its end. Its run id. */
async function stubRun(repoDir: string, testsPassAt: number): Promise<string> {
  writeStub(repoDir, { testsPassAt });
  const ended = await runWorkflow({ cwd: repoDir, workflow: 'ticket-to-pr' });
  if ('refused' in ended) throw new Error(`refused: ${ended.refused}`);
  return ended.runId;
}

// biome-ignore format: TDD-PENDING TASK-006
test
  .skip // TDD-PENDING TASK-006
  .each([[GOLDEN_RUN_ID], ['FAKE-1']])("sail show %s prints the golden run's calls, loops, totals and cost", async (name) => {
  await withTempRepo(async (repo) => {
    emptySailDir(repo.dir);
    copyGoldenRun(repo.dir);
    const captured = await runCaptured(['show', name], repo.dir);
    console.log(captured.stdout);
    expect(captured).toEqual({ code: EXIT_OK, stdout: GOLDEN, stderr: '' });
  });
});

// biome-ignore format: TDD-PENDING TASK-006
test
  .skip // TDD-PENDING TASK-006
  ('a failed run shows its stop reason in the title and a stop row, and sail show still exits 0', async () => {
  await withTempRepo(async (repo) => {
    const runId = await stubRun(repo.dir, 99);
    const { code, stdout } = await runCaptured(['show', runId], repo.dir);
    const lines = stdout.trimEnd().split('\n');
    expect(lines[0]).toMatch(new RegExp(`^${runId} · ticket-to-pr@1 · failed · workflow_failed · \\S+( \\S+)?$`));
    expect(lines.slice(-4)).toEqual([
      'stop    workflow_failed: loop "fix" exceeded 3',
      'loops   fix 3/3',
      'totals  7 calls · 7 steps · 0 tool calls · 0 denials · 8 replays',
      'cost    $0.00 of $25.00 (0%)',
    ]);
    expect(code).toBe(EXIT_OK);
  });
}, 20_000);

// biome-ignore format: TDD-PENDING TASK-006
test
  .skip // TDD-PENDING TASK-006
  ('a run with no budget shows its cost alone, and no loops row when no loop ran', async () => {
  await withTempRepo(async (repo) => {
    emptySailDir(repo.dir);
    runWith(
      repo.dir,
      ndjson(
        stamp(
          [0, runStart()],
          [50, start('spec#1')],
          [1450, end('spec#1', 'passed', 1400)],
          [1460, journal('spec#1', 1, 'passed')],
          [1500, runEnd('completed', 2)],
        ),
      ),
    );
    expect(await runCaptured(['show', GOLDEN_RUN_ID], repo.dir)).toEqual({
      code: EXIT_OK,
      stdout: text(
        `${GOLDEN_RUN_ID} · ticket-to-pr@1 · completed · 1.5s`,
        '',
        'key     kind    outcome  duration  cost  next',
        'spec#1  script  passed   1.4s',
        '',
        'totals  1 call · 1 step · 0 tool calls · 0 denials · 2 replays',
        'cost    $0.00',
      ),
      stderr: '',
    });
  });
});

// biome-ignore format: TDD-PENDING TASK-006
test
  .skip // TDD-PENDING TASK-006
  ('a run with no calls yet says so', async () => {
  await withTempRepo(async (repo) => {
    emptySailDir(repo.dir);
    runWith(repo.dir, ndjson(stamp([0, runStart({ maxUsd: 25, maxMinutes: 90 })])));
    expect(await runCaptured(['show', GOLDEN_RUN_ID], repo.dir)).toEqual({
      code: EXIT_OK,
      stdout: text(
        `${GOLDEN_RUN_ID} · ticket-to-pr@1 · running · 0ms`,
        '',
        'no calls yet',
        '',
        'totals  0 calls · 0 steps · 0 tool calls · 0 denials · 0 replays',
        'cost    $0.00 of $25.00 (0%)',
      ),
      stderr: '',
    });
  });
});

// biome-ignore format: TDD-PENDING TASK-006
test
  .skip // TDD-PENDING TASK-006
  ('sail show --rebuild writes summary.json from the events, says where, then shows the run', async () => {
  await withTempRepo(async (repo) => {
    emptySailDir(repo.dir);
    const dir = copyGoldenRun(repo.dir);
    rmSync(join(dir, 'summary.json'));
    expect(await runCaptured(['show', 'FAKE-1', '--rebuild'], repo.dir)).toEqual({
      code: EXIT_OK,
      stdout: `rebuilt .sail-runs/${GOLDEN_RUN_ID}/summary.json\n${GOLDEN}`,
      stderr: '',
    });
    expect(validateDocument('sail.summary.v1', JSON.parse(summaryText(dir) || 'null')).map(formatIssue)).toEqual([]);
  });
});

// biome-ignore format: TDD-PENDING TASK-006
test
  .skip // TDD-PENDING TASK-006
  ('sail show --rebuild of a stub run writes the summary.json the run wrote, byte for byte', async () => {
  await withTempRepo(async (repo) => {
    const runId = await stubRun(repo.dir, 1);
    const dir = join(repo.dir, '.sail-runs', runId);
    const written = summaryText(dir);
    rmSync(join(dir, 'summary.json'), { force: true });
    const { code } = await runCaptured(['show', runId, '--rebuild'], repo.dir);
    expect([code, summaryText(dir)]).toEqual([EXIT_OK, written]);
    expect(written).not.toBe('');
  });
}, 20_000);

const OTHER_RUN_ID = 'FAKE-1-01M3BWNZM08Q4T6V2XRJ5KWD3P';

/** A copy of the golden run whose events.ndjson is changed by `change`. */
function changedEvents(repoDir: string, change: (lines: string[]) => string[]): void {
  const dir = copyGoldenRun(repoDir);
  const path = join(dir, 'events.ndjson');
  writeFileSync(path, change(readFileSync(path, 'utf8').split('\n')).join('\n'));
}

type Refusal = (repoDir: string) => { argv: string[]; stderr: unknown };

// biome-ignore format: TDD-PENDING TASK-006
test
  .skip // TDD-PENDING TASK-006
  .each<[string, Refusal]>([
  [
    'a run that matches nothing',
    (repoDir) => {
      copyGoldenRun(repoDir);
      return { argv: ['show', 'NOPE'], stderr: "sail show: no run matching 'NOPE' in .sail-runs\n" };
    },
  ],
  [
    'a prefix two runs start with',
    (repoDir) => {
      copyGoldenRun(repoDir);
      copyGoldenRun(repoDir, { runId: OTHER_RUN_ID });
      return {
        argv: ['show', 'FAKE-1'],
        stderr: `sail show: 'FAKE-1' matches 2 runs: ${GOLDEN_RUN_ID}, ${OTHER_RUN_ID}\n`,
      };
    },
  ],
  [
    'events that hold no run:start',
    (repoDir) => {
      changedEvents(repoDir, (lines) => lines.slice(1));
      return { argv: ['show', GOLDEN_RUN_ID], stderr: `sail show: run ${GOLDEN_RUN_ID}'s events hold no run:start\n` };
    },
  ],
  [
    '--rebuild of events that hold no run:start',
    (repoDir) => {
      changedEvents(repoDir, (lines) => lines.slice(1));
      return {
        argv: ['show', GOLDEN_RUN_ID, '--rebuild'],
        stderr: `sail show: run ${GOLDEN_RUN_ID}'s events hold no run:start, so there is no summary to build\n`,
      };
    },
  ],
  [
    "an events line that can't be read",
    (repoDir) => {
      const dir = copyGoldenRun(repoDir);
      const line = readFileSync(join(dir, 'events.ndjson'), 'utf8').split('\n').length;
      appendFileSync(join(dir, 'events.ndjson'), 'not json\n');
      return {
        argv: ['show', GOLDEN_RUN_ID],
        stderr: expect.stringMatching(new RegExp(`^sail show: events\\.ndjson:${line} can't be read: .`)),
      };
    },
  ],
  [
    '--rebuild with --events',
    (repoDir) => {
      copyGoldenRun(repoDir);
      return { argv: ['show', GOLDEN_RUN_ID, '--rebuild', '--events'], stderr: expect.stringMatching(/^sail show: .*--rebuild.*--events/) };
    },
  ],
  [
    '--rebuild with --follow',
    (repoDir) => {
      copyGoldenRun(repoDir);
      return { argv: ['show', GOLDEN_RUN_ID, '--rebuild', '--follow'], stderr: expect.stringMatching(/^sail show: .*--rebuild.*--follow/) };
    },
  ],
  [
    'a repository with no .sail/',
    (repoDir) => {
      rmSync(join(repoDir, '.sail'), { recursive: true });
      copyGoldenRun(repoDir);
      return {
        argv: ['show', GOLDEN_RUN_ID],
        stderr: `sail show: no .sail/ between ${repoDir} and the git root ${repoDir}\n`,
      };
    },
  ],
])('sail show refuses %s with exit 3', async (_, prepare) => {
  await withTempRepo(async (repo) => {
    emptySailDir(repo.dir);
    const { argv, stderr } = prepare(repo.dir);
    expect(await runCaptured(argv, repo.dir)).toEqual({ code: EXIT_REFUSED, stdout: '', stderr: stderr as string });
  });
});

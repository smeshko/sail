// `sail show`, in process through run(): the golden run copied into a temp repository beside a `.sail/` with nothing in
// it, since the command never reads project.yaml, runs written by hand, and stub runs. The golden table is D12's, written
// by hand. `--events` and `--follow` print 4.2's terminal view, so FAKE-1's golden views in test/fixtures/terminal/ are
// theirs too.
import { expect, test } from 'bun:test';
import { appendFileSync, existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { EXIT_OK, EXIT_REFUSED, EXIT_SUSPENDED } from '../../src/cli/exit-codes';
import { type Io, run } from '../../src/cli/index';
import { runWorkflow } from '../../src/engine/runtime';
import { formatIssue, validateDocument } from '../../src/engine/schemas';
import type { Tty } from '../../src/events/consumers/screen';
import { fakeAdapters } from '../helpers/adapters';
import { end, journal, ndjson, runEnd, runStart, stamp, start } from '../helpers/events';
import { copyGoldenRun, emptySailDir, GOLDEN_RUN, GOLDEN_RUN_ID } from '../helpers/golden-run';
import { type Captured, fakeInterrupts, normaliseDurations, runCaptured } from '../helpers/run-captured';
import { copyRun, interruptWhenAsleep, writeStub } from '../helpers/stub-workflow';
import { withTempRepo } from '../helpers/temp-repo';

const text = (...lines: string[]) => lines.map((line) => `${line}\n`).join('');

/** What `sail show` prints for the golden run. */
const GOLDEN = text(
  `${GOLDEN_RUN_ID} · ticket-to-pr@1 · completed · 1m 11s`,
  '',
  'key                   kind     outcome  duration  cost   next',
  'intake#1              builtin  passed   2.1s',
  'spec#1                agent    done     10.4s     $0.31  implement#1',
  'implement#1           agent    done     12.6s     $0.48  tests#1',
  'tests#1               script   failed   2.5s             implement#2',
  'implement#2           agent    done     12.5s     $0.24  tests#2',
  'tests#2               script   passed   2.7s             self-review#1',
  'self-review#1         agent    done     10.5s     $0.22  publish#1',
  'publish#1                      passed   14.5s     $0.10  end',
  '  publish#1/describe  agent    done     10.4s     $0.10',
  '  publish#1/open      script   passed   3.8s',
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
  const ended = await runWorkflow({ cwd: repoDir, adapters: await fakeAdapters(repoDir), workflow: 'ticket-to-pr' });
  if ('refused' in ended) throw new Error(`refused: ${ended.refused}`);
  return ended.runId;
}

test.each([[GOLDEN_RUN_ID], ['FAKE-1']])(
  "sail show %s prints the golden run's calls, loops, totals and cost",
  async (name) => {
    await withTempRepo(async (repo) => {
      emptySailDir(repo.dir);
      copyGoldenRun(repo.dir);
      const captured = await runCaptured(['show', name], repo.dir);
      expect(captured).toEqual({ code: EXIT_OK, stdout: GOLDEN, stderr: '' });
    });
  },
);

test('a failed run shows its stop reason in the title and a stop row, and sail show still exits 0', async () => {
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

test('a run with no budget shows its cost alone, and no loops row when no loop ran', async () => {
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

test('a run with no calls yet says so', async () => {
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

test('sail show --rebuild writes summary.json from the events, says where, then shows the run', async () => {
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

test('sail show --rebuild of a stub run writes the summary.json the run wrote, byte for byte', async () => {
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

test.each<[string, Refusal]>([
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
      return {
        argv: ['show', GOLDEN_RUN_ID, '--rebuild', '--events'],
        stderr: expect.stringMatching(/^sail show: .*--rebuild.*--events/),
      };
    },
  ],
  [
    '--rebuild with --follow',
    (repoDir) => {
      copyGoldenRun(repoDir);
      return {
        argv: ['show', GOLDEN_RUN_ID, '--rebuild', '--follow'],
        stderr: expect.stringMatching(/^sail show: .*--rebuild.*--follow/),
      };
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

// TASK-008: --events and --follow.

/** FAKE-1's golden view at `verbosity`: what `sail run` printed for it. */
const goldenView = (verbosity: string): string =>
  readFileSync(join(import.meta.dir, '..', 'fixtures', 'terminal', `${verbosity}.txt`), 'utf8');

/** The golden run's events.ndjson, a line each, newlines kept. */
const goldenLines = (): string[] => readFileSync(join(GOLDEN_RUN, 'events.ndjson'), 'utf8').split(/(?<=\n)/);

/** A copy of the golden run as it was while running: its first 60 events, up to implement#2's start, and STATUS running. */
function runningRun(repoDir: string): string {
  const dir = runWith(repoDir, goldenLines().slice(0, 60).join(''));
  writeFileSync(join(dir, 'STATUS'), 'running\n');
  return dir;
}

/** `sail <argv>` started in process from `cwd`, with what it has printed so far readable while it runs. */
function started(argv: string[], cwd: string, options: { onInterrupt?: Io['onInterrupt']; tty?: Tty } = {}) {
  let stdout = '';
  let stderr = '';
  const io: Io = {
    cwd,
    stdout: (text) => {
      stdout += text;
    },
    stderr: (text) => {
      stderr += text;
    },
    ...(options.onInterrupt === undefined ? {} : { onInterrupt: options.onInterrupt }),
    ...(options.tty === undefined ? {} : { tty: options.tty }),
  };
  const done: Promise<Captured> = run(argv, io).then((code) => ({ code, stdout, stderr }));
  return { done, printed: () => stdout };
}

/** Waits until `condition` holds, for up to 5 s. */
async function until(condition: () => boolean): Promise<void> {
  const deadline = performance.now() + 5_000;
  while (!condition()) {
    if (performance.now() > deadline) throw new Error('not settled within 5 s');
    await Bun.sleep(5);
  }
}

test('sail show --events prints exactly what sail run printed for a completed stub run', async () => {
  await withTempRepo(async (repo) => {
    writeStub(repo.dir);
    const live = await runCaptured(['run'], repo.dir);
    expect([live.code, live.stdout]).toEqual([EXIT_OK, expect.stringContaining('\ncompleted · ')]);
    const runId = readdirSync(join(repo.dir, '.sail-runs'))[0] ?? '';
    expect(await runCaptured(['show', runId, '--events'], repo.dir)).toEqual({
      code: EXIT_OK,
      stdout: live.stdout,
      stderr: '',
    });
  });
}, 30_000);

test.each<[string[], string]>([
  [[], 'normal'],
  [['-q'], 'quiet'],
  [['-v'], 'verbose'],
  [['-vv'], 'trace'],
])('sail show FAKE-1 --events %p prints its %s golden view', async (flags, verbosity) => {
  await withTempRepo(async (repo) => {
    emptySailDir(repo.dir);
    copyGoldenRun(repo.dir);
    expect(await runCaptured(['show', 'FAKE-1', '--events', ...flags], repo.dir)).toEqual({
      code: EXIT_OK,
      stdout: goldenView(verbosity),
      stderr: '',
    });
  });
});

test("sail show --events of a resumed run prints both processes' events in order, the suspended final block first", async () => {
  await withTempRepo(async (repo) => {
    // Run in a repository of its own, as resume.test.ts does: one run per .sail/ in a process.
    const interrupted = await withTempRepo(async (from) => {
      writeStub(from.dir, { sleepAt: 'implement#2' });
      const interrupts = fakeInterrupts();
      const running = runCaptured(['run'], from.dir, interrupts);
      const { end } = await interruptWhenAsleep(from.dir, running, interrupts.interrupt);
      copyRun(from.dir, repo.dir);
      return end;
    });
    const runId = readdirSync(join(repo.dir, '.sail-runs'))[0] ?? '';
    const resumed = await runCaptured(['resume', runId], repo.dir);
    expect([interrupted.code, resumed.code]).toEqual([EXIT_SUSPENDED, EXIT_OK]);

    const shown = await runCaptured(['show', runId, '--events'], repo.dir);
    // Each process's view of the run's events: the run without how to resume it, and the resume without its opening line.
    const first = interrupted.stdout.replace(`resume it with: sail resume ${runId}\n`, '');
    const second = resumed.stdout.slice(resumed.stdout.indexOf('\n') + 1);
    expect(shown).toEqual({ code: EXIT_OK, stdout: first + second, stderr: '' });
    const blocks = normaliseDurations(shown.stdout).match(/^(suspended|completed) · <t>$/gm);
    expect(blocks).toEqual(['suspended · <t>', 'completed · <t>']);
  });
}, 60_000);

test('sail show --follow on a running run prints events as they are appended, and exits 0 once the run ends', async () => {
  await withTempRepo(async (repo) => {
    emptySailDir(repo.dir);
    const dir = runningRun(repo.dir);
    const following = started(['show', GOLDEN_RUN_ID, '--follow'], repo.dir);
    await until(() => following.printed() !== '');
    const early = following.printed();
    appendFileSync(join(dir, 'events.ndjson'), goldenLines().slice(60).join(''));
    writeFileSync(join(dir, 'STATUS'), 'completed\n');
    expect(await following.done).toEqual({ code: EXIT_OK, stdout: goldenView('normal'), stderr: '' });
    expect(goldenView('normal').startsWith(early)).toBe(true);
    expect(early).toContain(`sail · ticket-to-pr v1 · ${GOLDEN_RUN_ID}\n`);
    expect(early).not.toContain('completed');
  });
});

test.each([[['--follow']], [['--events', '--follow']]])(
  'sail show %p on a finished run prints the whole stream and exits 0',
  async (flags) => {
    await withTempRepo(async (repo) => {
      emptySailDir(repo.dir);
      copyGoldenRun(repo.dir);
      expect(await runCaptured(['show', GOLDEN_RUN_ID, ...flags], repo.dir)).toEqual({
        code: EXIT_OK,
        stdout: goldenView('normal'),
        stderr: '',
      });
    });
  },
);

test('sail show --follow stopped by Ctrl-C exits 0 with what it printed so far, and reads nothing after', async () => {
  await withTempRepo(async (repo) => {
    emptySailDir(repo.dir);
    const dir = runningRun(repo.dir);
    const sofar = await runCaptured(['show', GOLDEN_RUN_ID, '--events'], repo.dir);
    expect(sofar.stdout).toContain('implement#2         ▶ implement');
    const interrupts = fakeInterrupts();
    const following = started(['show', GOLDEN_RUN_ID, '--follow'], repo.dir, interrupts);
    await until(() => following.printed() !== '');
    interrupts.interrupt();
    expect(await following.done).toEqual({ code: EXIT_OK, stdout: sofar.stdout, stderr: '' });
    expect([interrupts.registered, interrupts.unregistered]).toEqual([1, 1]);
    // A poll left running would print these within 200 ms.
    appendFileSync(join(dir, 'events.ndjson'), goldenLines().slice(60).join(''));
    await Bun.sleep(300);
    expect(following.printed()).toBe(sofar.stdout);
  });
});

test('in a terminal, sail show --follow stopped by Ctrl-C clears its live line and leaves no timer behind', async () => {
  await withTempRepo(async (repo) => {
    emptySailDir(repo.dir);
    runningRun(repo.dir);
    const interrupts = fakeInterrupts();
    const following = started(['show', GOLDEN_RUN_ID, '--follow'], repo.dir, {
      onInterrupt: interrupts.onInterrupt,
      tty: { columns: () => 120 },
    });
    await until(() => following.printed().includes('implement#2 running'));
    interrupts.interrupt();
    const { code, stdout } = await following.done;
    expect(code).toBe(EXIT_OK);
    expect(stdout.endsWith('\r\x1b[2K')).toBe(true);
    // The live line redraws every 100 ms while its timer runs.
    await Bun.sleep(300);
    expect(following.printed()).toBe(stdout);
  });
});

test.each<[string[], string]>([
  [['-v'], 'sail show: -q and -v apply to --events and --follow\n'],
  [['-q'], 'sail show: -q and -v apply to --events and --follow\n'],
  [['--rebuild', '-vv'], 'sail show: -q and -v apply to --events and --follow\n'],
  [['--events', '-q', '-v'], "sail show: -q and -v can't be combined\n"],
])('sail show %p refuses with exit 3', async (flags, stderr) => {
  await withTempRepo(async (repo) => {
    emptySailDir(repo.dir);
    copyGoldenRun(repo.dir);
    expect(await runCaptured(['show', GOLDEN_RUN_ID, ...flags], repo.dir)).toEqual({
      code: EXIT_REFUSED,
      stdout: '',
      stderr,
    });
  });
});

test.each([['--events'], ['--follow']])(
  "sail show %s refuses an events line that can't be read with exit 3, and prints no event",
  async (flag) => {
    await withTempRepo(async (repo) => {
      emptySailDir(repo.dir);
      const dir = copyGoldenRun(repo.dir);
      appendFileSync(join(dir, 'events.ndjson'), 'not json\n');
      const line = goldenLines().length + 1;
      expect(await runCaptured(['show', GOLDEN_RUN_ID, flag], repo.dir)).toEqual({
        code: EXIT_REFUSED,
        stdout: '',
        stderr: expect.stringMatching(new RegExp(`^sail show: events\\.ndjson:${line} can't be read: .`)),
      });
    });
  },
);

// biome-ignore format: TDD-PENDING TASK-012
test
  .skip // TDD-PENDING TASK-012
  ("sail show lists a ticket run's intake#1 first, with its kind, its outcome and its duration, and --events prints what the run printed, the intake's lines included", async () => {
  await withTempRepo(async (repo) => {
    writeStub(repo.dir, { ticket: true, testsPassAt: 1 });
    const helper = join(import.meta.dir, '..', 'helpers', 'ticket-run.ts');
    const ran = Bun.spawnSync([process.execPath, helper, 'FAKE-1'], { cwd: repo.dir, env: repo.env });
    const [runId = ''] = readdirSync(join(repo.dir, '.sail-runs'));

    const shown = await runCaptured(['show', runId], repo.dir);
    const rows = normaliseDurations(shown.stdout).split('\n');
    expect(rows[0]).toBe(`${runId} · ticket-to-pr@1 · completed · <t>`);
    expect(rows[2]).toMatch(/^key +kind +outcome +duration\b/);
    expect(rows[3]).toMatch(/^intake#1 +builtin +passed +<t>$/);
    expect(rows[4]).toMatch(/^spec#1 +script +passed +<t> +implement#1$/);
    expect(shown.stdout).toContain('\ntotals  6 calls · ');
    expect({ code: shown.code, stderr: shown.stderr }).toEqual({ code: EXIT_OK, stderr: '' });

    const replayed = await runCaptured(['show', runId, '--events'], repo.dir);
    expect(replayed.stdout).toContain(`${'intake#1'.padEnd(13)}  ▶ intake ticket · builtin\n`);
    expect(normaliseDurations(replayed.stdout)).toBe(normaliseDurations(ran.stdout.toString()));
    expect(ran.exitCode).toBe(0);
  });
}, 30_000);

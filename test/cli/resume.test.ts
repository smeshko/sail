// `sail resume`, in process through run(): a run of the stub repository, started with `sail FAKE-1` and interrupted or
// ended in a repository of its own, then copied into the test's repository and resumed there. A process opens one run
// per .sail/, and Bun caches the workflow's modules by path, so the run and its resume never share a .sail/.
import { expect, test } from 'bun:test';
import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { basename, join } from 'node:path';
import { EXIT_FAILED, EXIT_OK, EXIT_REFUSED, EXIT_SUSPENDED, type ExitCode } from '../../src/cli/exit-codes';
import { readJournal } from '../../src/engine/journal';
import { readStatus } from '../../src/engine/run-dir';
import { formatIssue, validateRunDir } from '../../src/engine/schemas';
import { readEvents } from '../../src/events/consumers/ndjson';
import { rebuildSummary } from '../../src/events/consumers/summary';
import type { Summary } from '../../src/events/summary';
import {
  interruptInSession,
  journaled,
  NO_TASKS,
  NO_TASKS_MESSAGE,
  RUN_ARGV,
  runDirIn,
  SPEC,
  sessions,
  specFile,
  specResult,
  submits,
  writeAgentFixture,
} from '../helpers/agent-fixture';
import { edit, FIXTURE_SAIL, write } from '../helpers/fixture';
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

/** The runs in the repository's `.sail-runs/`: every entry but `fake/`, where the fake adapters keep their state. */
const runIds = (repoDir: string): string[] =>
  existsSync(join(repoDir, '.sail-runs'))
    ? readdirSync(join(repoDir, '.sail-runs')).filter((name) => name !== 'fake')
    : [];
const runIdIn = (repoDir: string) => runIds(repoDir)[0] ?? '';

/** `sail FAKE-1` on the stub in a repository of its own, interrupted during `implement#2`, then copied into `to`. */
function interruptedInto(to: string): Promise<string> {
  return withTempRepo(async (from) => {
    writeStub(from.dir, { sleepAt: 'implement#2' });
    const interrupts = fakeInterrupts();
    const running = runCaptured(['FAKE-1'], from.dir, interrupts);
    const { end } = await interruptWhenAsleep(from.dir, running, interrupts.interrupt);
    expect({ code: end.code, stderr: end.stderr }).toEqual({ code: EXIT_SUSPENDED, stderr: '' });
    copyRun(from.dir, to);
    return runIdIn(to);
  });
}

/** `sail FAKE-1` on the stub to its end, `code`, in a repository of its own, then copied into `to`. */
function endedInto(to: string, options: StubOptions, code: ExitCode): Promise<string> {
  return withTempRepo(async (from) => {
    writeStub(from.dir, options);
    const ended = await runCaptured(['FAKE-1'], from.dir);
    expect({ code: ended.code, stderr: ended.stderr }).toEqual({ code, stderr: '' });
    copyRun(from.dir, to);
    return runIdIn(to);
  });
}

/** Each run's STATUS and journal, by run id: what a refusal must leave as it was. */
function runFiles(repoDir: string): Record<string, string[]> {
  const runs = join(repoDir, '.sail-runs');
  return Object.fromEntries(
    runIds(repoDir).map((runId) => [
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

test('sail resume opens with what already ran, runs the interrupted call as its second try, and ends with the whole run', async () => {
  await withTempRepo(async (repo) => {
    const runId = await interruptedInto(repo.dir);
    const { code, stdout, stderr } = await runCaptured(['resume', runId], repo.dir);
    expect(normaliseDurations(stdout)).toBe(
      [
        `sail · ticket-to-pr v1 · ${runId} · resumed after 4 calls, last tests#1 failed`,
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
        '  calls    8 · 7 passed, 1 failed',
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

test('-q with -v is refused with exit 3, and the run is left as it was', async () => {
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
      const runId = await endedInto(repoDir, { testsPassAt: 1 }, EXIT_OK);
      return { argv: ['resume', runId], message: `run ${runId} has completed: there is nothing to resume` };
    },
  ],
  [
    'a failed run',
    async (repoDir) => {
      const runId = await endedInto(repoDir, { testsPassAt: 99 }, EXIT_FAILED);
      return { argv: ['resume', runId], message: `run ${runId} failed (workflow_failed): a failed run is final` };
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

test('an id that names no run is refused with exit 3, and nothing is created', async () => {
  await withTempRepo(async (repo) => {
    writeStub(repo.dir);
    expect(await runCaptured(['resume', 'FAKE-1-NOPE'], repo.dir)).toEqual({
      code: EXIT_REFUSED,
      stdout: '',
      stderr: "sail resume: no run 'FAKE-1-NOPE' in .sail-runs\n",
    });
    expect(runFiles(repo.dir)).toEqual({});
  });
});

test('a workflow whose keys no longer fit the journal fails the resume with determinism_violation, and exits 1', async () => {
  await withTempRepo(async (repo) => {
    const runId = await interruptedInto(repo.dir);
    swapImplementAndTests(join(repo.dir, '.sail'));
    const { code, stdout } = await runCaptured(['resume', runId], repo.dir);
    expect(normaliseDurations(stdout)).toBe(
      [
        `sail · ticket-to-pr v1 · ${runId} · resumed after 4 calls, last tests#1 failed`,
        '',
        'failed · <t>',
        "  stop     determinism_violation: the workflow asked for 'tests#1' where the journal has 'implement#1'",
        '  calls    4 · 3 passed, 1 failed',
        '  loops    fix 2/3',
        `  replays  ${replaysOf(repo.dir, runId)}`,
        `  run      .sail-runs/${runId}`,
        '',
      ].join('\n'),
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
    const view = normaliseDurations(end.stdout);
    expect(view).toContain(
      '\nimplement#2    ✗ error · <t>\nimplement#2      exit_code: interrupted, then ended by signal SIGTERM\n',
    );
    expect(view).toEndWith(
      [
        '',
        'suspended · <t>',
        '  stop     interrupted: stopped during implement#2',
        '  calls    4 · 3 passed, 1 failed',
        '  loops    fix 2/3',
        `  replays  ${replaysOf(repo.dir, runId)}`,
        `  run      .sail-runs/${runId}`,
        `resume it with: sail resume ${runId}`,
        '',
      ].join('\n'),
    );
    expect(end.code).toBe(EXIT_SUSPENDED);
    expect(alive).toEqual([]);
    expect([interrupts.registered, interrupts.unregistered]).toEqual([1, 1]);
    const tryTwo = join(repo.dir, '.sail-runs', runId, '02-implement', 'call-2', 'try-2', 'result.json');
    expect(existsSync(tryTwo)).toBe(true);
  });
}, 30_000);

test('sail resume refuses a run whose harness the config now swaps, leaves the run as it was, and resumes once the config is swapped back', async () => {
  await withTempRepo(async (repo) => {
    const runId = await interruptedInto(repo.dir);
    const sail = join(repo.dir, '.sail');
    write(sail, 'adapters/echo-harness.ts', readFileSync(join(FIXTURE_SAIL, 'adapters', 'echo-harness.ts'), 'utf8'));
    edit(sail, 'project.yaml', 'harness: { use: fake }', 'harness: { use: ./adapters/echo-harness.ts }');
    const before = runFiles(repo.dir);

    const env = { ECHO_HARNESS_TOKEN: 'echo-token-3b8e51' };
    const refused = await runCaptured(['resume', runId], repo.dir, { env });
    expect(refused.code).toBe(EXIT_REFUSED);
    expect(refused.stdout).toBe('');
    expect(refused.stderr).toStartWith(`sail resume: run ${runId} can't resume on different adapters:`);
    expect(refused.stderr).toContain(
      'harness: the run started with fake (builtin), and .sail/project.yaml now names ./adapters/echo-harness.ts (repo:.sail/adapters/echo-harness.ts)',
    );
    expect(runFiles(repo.dir)).toEqual(before);

    edit(sail, 'project.yaml', 'harness: { use: ./adapters/echo-harness.ts }', 'harness: { use: fake }');
    const resumed = await runCaptured(['resume', runId], repo.dir);
    expect(resumed.code).toBe(EXIT_OK);
    expect(resumed.stderr).toBe('');
  });
}, 30_000);

// Agent stages across a resume: brief-to-spec on the fake harness, interrupted or killed while a session of spec#1 sits
// in the delay its answer scripts, then resumed.

const shim = join(import.meta.dir, '..', '..', 'src', 'cli', 'main.ts');

/** A result's outcome and its place among its call's tries. */
const placeOf = (result: Record<string, unknown>) => ({
  outcome: result.outcome,
  try: result.try,
  validationTry: result.validationTry,
  validationFailed: result.validationFailed,
});

/** The run's summary.json, then the same file rebuilt from the run's events alone. */
function summaries(dir: string): { written: Summary; rebuilt: unknown; same: boolean } {
  const path = join(dir, 'summary.json');
  const text = readFileSync(path, 'utf8');
  rmSync(path);
  const rebuilt = rebuildSummary(dir);
  return { written: JSON.parse(text), rebuilt, same: readFileSync(path, 'utf8') === text };
}

test('sail resume takes up a correction it was interrupted in: the next try is still the second validation, told the original problems, on the model the run started with, and every session is counted once', async () => {
  await withTempRepo(async (repo) => {
    const runId = await withTempRepo(async (from) => {
      writeAgentFixture(from.dir, [
        submits(NO_TASKS, 0.125),
        submits(SPEC, 0.5, { turns: 2, delayMs: 30_000 }),
        submits(SPEC, 0.25),
      ]);
      const interrupts = fakeInterrupts();
      const running = runCaptured(RUN_ARGV, from.dir, interrupts);
      const { code, stdout } = await interruptInSession(from.dir, running, interrupts.interrupt, 2);
      expect(code).toBe(EXIT_SUSPENDED);
      const id = basename(runDirIn(from.dir));
      expect(stdout).toEndWith(`\nresume it with: sail resume ${id}\n`);
      copyRun(from.dir, repo.dir);
      return id;
    });

    // The alias names another model by now. The run goes on with the one its roster froze.
    edit(join(repo.dir, '.sail'), 'project.yaml', 'deep: claude-opus-5-5', 'deep: claude-next');
    const { code, stdout, stderr } = await runCaptured(['resume', runId], repo.dir);
    expect({ code, stderr }).toEqual({ code: EXIT_OK, stderr: '' });
    const view = normaliseDurations(stdout).split('\n');
    expect(view[0]).toBe(`sail · brief-to-spec v1 · ${runId} · resumed after 2 calls, last brief#1 passed`);
    expect(view.filter((line) => line.startsWith('spec#1'))).toEqual([
      'spec#1     ▶ spec · agent · claude-opus-5-5 · try 3',
      'spec#1       output valid',
      'spec#1     ✓ done · <t>',
    ]);

    const dir = join(repo.dir, '.sail-runs', runId);
    expect(journaled(dir)).toEqual(['intake#1 passed', 'brief#1 passed', 'spec#1 done', 'publish#1 passed']);
    expect([1, 2, 3].map((n) => placeOf(specResult(dir, n)))).toEqual([
      { outcome: 'error', try: 1, validationTry: 1, validationFailed: true },
      { outcome: 'error', try: 2, validationTry: 2, validationFailed: false },
      { outcome: 'done', try: 3, validationTry: 2, validationFailed: false },
    ]);
    expect(specResult(dir, 3)).toMatchObject({ harness: { model: 'claude-opus-5-5' } });
    const prompt = specFile(dir, 'prompt.md', 3) ?? '';
    expect([prompt.includes(NO_TASKS_MESSAGE), prompt.includes('aborted')]).toEqual([true, false]);

    expect(sessions(readEvents(dir))).toEqual([
      'start fake-session-spec-1',
      'end fake-session-spec-1 done 0.125',
      'start fake-session-spec-1-try-2',
      'end fake-session-spec-1-try-2 error 0.5',
      'start fake-session-spec-1-try-3',
      'end fake-session-spec-1-try-3 done 0.25',
    ]);
    const { written, rebuilt, same } = summaries(dir);
    expect(written.totals.usage).toEqual({ inputTokens: 7000, outputTokens: 700, costUsd: 0.875 });
    expect(written.calls.find((call) => call.key === 'spec#1')).toMatchObject({
      outcome: 'done',
      costUsd: 0.25,
      resultPath: '02-spec/call-1/try-3/result.json',
    });
    expect([rebuilt, same]).toEqual([{ summary: written, path: join(dir, 'summary.json') }, true]);
    expect(validateRunDir(dir).issues.map(formatIssue)).toEqual([]);
  });
}, 60_000);

test('a run whose process was killed in a session resumes: the session is ended with the usage it had reported, and its usage and that of the next are each counted once', async () => {
  await withTempRepo(async (repo) => {
    writeAgentFixture(repo.dir, [submits(SPEC, 0.5, { turns: 2, delayMs: 60_000 }), submits(SPEC, 0.25)]);
    const child = Bun.spawn([process.execPath, shim, ...RUN_ARGV], {
      cwd: repo.dir,
      env: repo.env,
      stdout: 'ignore',
      stderr: 'ignore',
    });
    await interruptInSession(repo.dir, child.exited, () => child.kill('SIGKILL'));
    expect(child.signalCode).toBe('SIGKILL');

    // A killed run looks as it did when it ran: nothing wrote how it ended, not even its session.
    const dir = runDirIn(repo.dir);
    expect(readStatus(dir)).toEqual({ status: 'running' });
    expect(sessions(readEvents(dir))).toEqual(['start fake-session-spec-1']);
    expect(specFile(dir, 'result.json')).toBeNull();

    const { code, stderr } = await runCaptured(['resume', basename(dir)], repo.dir);
    expect({ code, stderr }).toEqual({ code: EXIT_OK, stderr: '' });
    expect(journaled(dir)).toEqual(['intake#1 passed', 'brief#1 passed', 'spec#1 done', 'publish#1 passed']);
    // The kill used none of the correction: nothing the session submitted was ever checked.
    expect(placeOf(specResult(dir, 2))).toEqual({ outcome: 'done', try: 2, validationTry: 1, validationFailed: false });
    expect(sessions(readEvents(dir))).toEqual([
      'start fake-session-spec-1',
      'end fake-session-spec-1 error 0.5',
      'start fake-session-spec-1-try-2',
      'end fake-session-spec-1-try-2 done 0.25',
    ]);
    const { written, rebuilt, same } = summaries(dir);
    expect(written.totals.usage).toMatchObject({ inputTokens: 6000, outputTokens: 600, costUsd: 0.75 });
    expect([rebuilt, same]).toEqual([{ summary: written, path: join(dir, 'summary.json') }, true]);
  });
}, 90_000);

// What a resume leaves alone: the intake, the ticket and the claim. And what `sail resume` no longer takes.

test('sail resume replays the intake from the journal: its line is as the start wrote it, and the ticket is neither fetched nor claimed again', async () => {
  await withTempRepo(async (repo) => {
    const runId = await interruptedInto(repo.dir);
    const dir = join(repo.dir, '.sail-runs', runId);
    const [first] = readFileSync(join(dir, 'journal.ndjson'), 'utf8').split('\n');
    const { code, stderr } = await runCaptured(['resume', runId], repo.dir);
    expect({ code, stderr }).toEqual({ code: EXIT_OK, stderr: '' });
    const { entries } = readJournal(dir);
    expect(entries.map((entry) => entry.key)).toEqual([
      'intake#1',
      'spec#1',
      'implement#1',
      'tests#1',
      'implement#2',
      'tests#2',
      'self-review#1',
      'publish#1',
    ]);
    expect(readFileSync(join(dir, 'journal.ndjson'), 'utf8').split('\n')[0]).toBe(first ?? '');
    const ticket = readEvents(dir).flatMap((event) => (event.type.startsWith('ticket:') ? [event.type] : []));
    expect(ticket).toEqual(['ticket:claimed', 'ticket:commented', 'ticket:fetched']);
    expect(validateRunDir(dir).issues.map(formatIssue)).toEqual([]);
  });
}, 30_000);

test('sail FAKE-1 sent SIGINT during implement#2 exits 2, sail resume in a new process exits 0, and across both the ticket is fetched into the stream once', async () => {
  await withTempRepo(async (repo) => {
    writeStub(repo.dir, { sleepAt: 'implement#2' });
    const started = Bun.spawn([process.execPath, shim, 'FAKE-1'], {
      cwd: repo.dir,
      env: repo.env,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const { end: code, alive } = await interruptWhenAsleep(repo.dir, started.exited, () => started.kill('SIGINT'));
    expect(await new Response(started.stderr).text()).toBe('');
    expect({ code, alive }).toEqual({ code: 2, alive: [] });
    const runId = runIdIn(repo.dir);
    const dir = join(repo.dir, '.sail-runs', runId);
    const suspended = await new Response(started.stdout).text();
    expect(suspended).toEndWith(`  run      .sail-runs/${runId}\nresume it with: sail resume ${runId}\n`);
    expect(suspended).toContain('\n  stop     interrupted: stopped during implement#2\n');

    const resumed = Bun.spawnSync([process.execPath, shim, 'resume', runId], { cwd: repo.dir, env: repo.env });
    expect(resumed.stdout.toString()).toStartWith(
      `sail · ticket-to-pr v1 · ${runId} · resumed after 4 calls, last tests#1 failed\n`,
    );
    expect(resumed.stderr.toString()).toBe('');
    expect(resumed.exitCode).toBe(0);
    expect(readStatus(dir)).toEqual({ status: 'completed' });
    const fetched = readEvents(dir).filter((event) => event.type === 'ticket:fetched');
    expect(fetched).toMatchObject([{ key: 'intake#1', ticketKey: 'FAKE-1' }]);
    expect(readJournal(dir).entries.map((entry) => entry.key)).toEqual([
      'intake#1',
      'spec#1',
      'implement#1',
      'tests#1',
      'implement#2',
      'tests#2',
      'self-review#1',
      'publish#1',
    ]);
    expect(validateRunDir(dir).issues.map(formatIssue)).toEqual([]);
  });
}, 60_000);

// biome-ignore format: TDD-PENDING TASK-011
test
  .skip // TDD-PENDING TASK-011
  ('sail resume --input is refused as an unknown argument with exit 3, and the run is left as it was', async () => {
  await withTempRepo(async (repo) => {
    const runId = await interruptedInto(repo.dir);
    const dir = join(repo.dir, '.sail-runs', runId);
    const files = () =>
      ['STATUS', 'events.ndjson', 'journal.ndjson'].map((name) => readFileSync(join(dir, name), 'utf8'));
    const before = files();
    expect(await runCaptured(['resume', runId, '--input', '{}'], repo.dir)).toEqual({
      code: EXIT_REFUSED,
      stdout: '',
      stderr: "sail: unknown argument '--input'\nRun 'sail --help' for usage.\n",
    });
    expect(files()).toEqual(before);
    expect(before[0]).toBe('suspended interrupted\n');
  });
}, 30_000);

// biome-ignore format: TDD-PENDING TASK-011
test
  .skip // TDD-PENDING TASK-011
  ('sail resume with no run id is refused with its usage, which takes a run and nothing else', async () => {
  await withTempRepo(async (repo) => {
    writeStub(repo.dir);
    expect(await runCaptured(['resume'], repo.dir)).toEqual({
      code: EXIT_REFUSED,
      stdout: '',
      stderr: 'sail resume: usage: sail resume <run>\n',
    });
  });
});

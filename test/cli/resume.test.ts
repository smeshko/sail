// `sail resume`, in process through run(): a run of the stub repository, started with `sail FAKE-1` and interrupted or
// ended in a repository of its own, then copied into the test's repository and resumed there. A process opens one run
// per .sail/, and Bun caches the workflow's modules by path, so the run and its resume never share a .sail/.
import { expect, test } from 'bun:test';
import { chmodSync, existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { EXIT_FAILED, EXIT_OK, EXIT_REFUSED, EXIT_SUSPENDED, type ExitCode } from '../../src/cli/exit-codes';
import { readJournal } from '../../src/engine/journal';
import { recordingKeepAwake } from '../../src/engine/keep-awake';
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
import { killOne, sailProcess, until } from '../helpers/sail-process';
import {
  copyRun,
  heldRuns,
  interruptWhenAsleep,
  releaseHeld,
  type StubOptions,
  setHoldAt,
  setSleepAt,
  swapImplementAndTests,
  whenSleeping,
  writeStub,
} from '../helpers/stub-workflow';
import { type TempRepo, withTempRepo } from '../helpers/temp-repo';

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

test('sail resume masks credentials from its own io.env in newly written calls', async () => {
  await withTempRepo(async (repo) => {
    const marker = 'ghp_RESUME_MARKER_0123456789';
    const runId = await withTempRepo(async (from) => {
      const sail = writeAgentFixture(from.dir, [submits(SPEC, 0.125, { messages: [`echo ${marker}`] })]);
      edit(
        sail,
        'workflows/brief-to-spec/stages/publish/run.sh',
        'set -euo pipefail',
        `set -euo pipefail\ntoken='ghp_RESUME_''MARKER_0123456789'\necho "token $token"\necho "stderr token $token" >&2`,
      );
      const started = await runCaptured([...RUN_ARGV, '--until', 'brief'], from.dir, { env: from.env });
      expect(started.code).toBe(EXIT_SUSPENDED);
      copyRun(from.dir, repo.dir);
      return runIdIn(repo.dir);
    });
    const captured = await runCaptured(['resume', runId, '-v'], repo.dir, {
      env: { ...repo.env, SAIL_TEST_TOKEN: marker },
    });
    expect(captured.code).toBe(EXIT_OK);
    expect(captured.stdout.includes(marker)).toBe(false);
    expect(captured.stdout.includes('│ token [redacted]')).toBe(true);
    expect(captured.stdout.includes('│ stderr token [redacted]')).toBe(true);
    expect(specFile(runDirIn(repo.dir), 'session.log')).toBe('assistant: echo [redacted]\n');
    const files = readdirSync(runDirIn(repo.dir), { recursive: true, withFileTypes: true }).filter((file) =>
      file.isFile(),
    );
    expect(files.length > 10).toBe(true);
    expect(
      files
        .filter((file) => readFileSync(join(file.parentPath, file.name), 'utf8').includes(marker))
        .map((file) => file.name),
    ).toEqual([]);
  });
});

test('sail resume holds the keep-awake for the resumed run and releases it at its end, the resume reporting its own', async () => {
  await withTempRepo(async (repo) => {
    const runId = await interruptedInto(repo.dir);
    const { keepAwake, calls } = recordingKeepAwake();
    const { code } = await runCaptured(['resume', runId], repo.dir, { keepAwake });
    const held = readEvents(join(repo.dir, '.sail-runs', runId)).filter((event) => event.type === 'run:keep_awake');
    expect({ code, calls }).toEqual({ code: EXIT_OK, calls: ['acquire', 'release'] });
    expect(held.at(-1)).toEqual(expect.objectContaining({ held: true, by: 'fake' }));
  });
});

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

// The flags are refused before the run is looked up, so no run needs to exist for either refusal below.
test('-q with -v is refused with exit 3, before any run is read', async () => {
  const { code, stdout, stderr } = await runCaptured(['resume', 'FAKE-1-NONE', '-qv'], tmpdir());
  expect({ code, stdout, stderr }).toEqual({
    code: EXIT_REFUSED,
    stdout: '',
    stderr: "sail resume: -q and -v can't be combined\n",
  });
});

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

test('resume refuses a run without a layout and changes nothing', async () => {
  await withTempRepo(async (repo) => {
    const runId = await interruptedInto(repo.dir);
    const dir = join(repo.dir, '.sail-runs', runId);
    const header = join(dir, 'run.json');
    const { layout: _, ...unmarked } = JSON.parse(readFileSync(header, 'utf8'));
    chmodSync(header, 0o644);
    writeFileSync(header, `${JSON.stringify(unmarked, null, 2)}\n`);
    const before = [readStatus(dir), leasesIn(repo), readFileSync(join(dir, 'events.ndjson'), 'utf8')];
    expect(await runCaptured(['resume', runId], repo.dir)).toEqual({
      code: EXIT_REFUSED,
      stdout: '',
      stderr: `sail resume: run ${runId} keeps its calls' records inside their $STAGE_OUT, as runs did before sail moved them to out/: it can't be resumed. sail stop ${runId} ends it\n`,
    });
    expect([readStatus(dir), leasesIn(repo), readFileSync(join(dir, 'events.ndjson'), 'utf8')]).toEqual(before);
  });
}, 30_000);

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

test('sail resume --input is refused as an unknown argument with exit 3, before any run is read', async () => {
  expect(await runCaptured(['resume', 'FAKE-1-NONE', '--input', '{}'], tmpdir())).toEqual({
    code: EXIT_REFUSED,
    stdout: '',
    stderr: "sail: unknown argument '--input'\nRun 'sail --help' for usage.\n",
  });
});

test('sail resume with no run id is refused with its usage, which takes a run and nothing else', async () => {
  expect(await runCaptured(['resume'], tmpdir())).toEqual({
    code: EXIT_REFUSED,
    stdout: '',
    stderr: 'sail resume: usage: sail resume <run>\n',
  });
});

// A resume in its run's own workspace (D8): each `sail` below is a process of its own, spawned with the repository's
// env, so a lease's pid is the process that took it and one repository holds the run from start to resume.

const MAIN = join(import.meta.dir, '..', '..', 'src', 'cli', 'main.ts');
const STUB_BRANCH = 'sail/FAKE-1-add-a-greeting';

/** `sail <argv>` in its own process in `repo`, run to its end. */
async function spawned(repo: TempRepo, ...argv: string[]): Promise<{ code: number; stderr: string; pid: number }> {
  const child = Bun.spawn([process.execPath, MAIN, ...argv], {
    cwd: repo.dir,
    env: repo.env,
    stdin: 'ignore',
    stdout: 'ignore',
    stderr: 'pipe',
  });
  const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  return { code, stderr, pid: child.pid };
}

/** The lease files the fakes keep in `repo`, parsed. */
const leasesIn = (repo: TempRepo): { runId: string; pid: number; runDir: string }[] => {
  const dir = join(repo.dir, '.sail-runs', 'fake', 'leases');
  return existsSync(dir)
    ? readdirSync(dir)
        .filter((name) => name.endsWith('.json'))
        .map((name) => JSON.parse(readFileSync(join(dir, name), 'utf8')))
    : [];
};

test("sail resume continues in the run's own worktree under a lease renewed with its pid, reports the renewal first, and releases both once it completes", async () => {
  await withTempRepo(async (repo) => {
    const sail = writeStub(repo.dir);
    edit(
      sail,
      'stages/implement/run.sh',
      "echo 'diff --git a/src/greet.ts b/src/greet.ts'",
      [
        'pwd >>"$STUB/pwd.log"',
        'if [ "$CALL" = 1 ]; then echo left >"$WORKSPACE/left.txt"; fi',
        'if [ -f "$WORKSPACE/left.txt" ]; then echo "$CALL" >>"$STUB/left.log"; fi',
        'cat "$(dirname "$STUB")"/.sail-runs/fake/leases/*.json >>"$STUB/leases.log"',
        "echo 'diff --git a/src/greet.ts b/src/greet.ts'",
      ].join('\n'),
    );
    const first = await spawned(repo, 'FAKE-1', '--until', 'implement');
    const runId = runIdIn(repo.dir);
    const dir = join(repo.dir, '.sail-runs', runId);
    const before = readEvents(dir).length;
    const resumed = await spawned(repo, 'resume', runId);
    const stub = (file: string) =>
      existsSync(join(repo.dir, '.stub', file))
        ? readFileSync(join(repo.dir, '.stub', file), 'utf8')
            .trimEnd()
            .split('\n')
        : [];
    const leased = stub('leases.log')
      .filter((line) => line.startsWith('{'))
      .map((line) => JSON.parse(line).pid as number);
    const workspace = join(dir, 'workspace');
    expect({
      codes: [first.code, resumed.code],
      pwd: stub('pwd.log'),
      left: stub('left.log'),
      leasedBy: leased,
      renewal: readEvents(dir)[before]?.type,
      after: { workspace: existsSync(workspace), leases: leasesIn(repo) },
    }).toEqual({
      codes: [EXIT_SUSPENDED, EXIT_OK],
      pwd: [workspace, workspace],
      left: ['1', '2'],
      leasedBy: [first.pid, resumed.pid],
      renewal: 'workspace:leased',
      after: { workspace: false, leases: [] },
    });
  });
}, 30_000);

test('sail resume refuses a run still running in another process, naming its pid, and leaves its STATUS and lease as they were', async () => {
  await withTempRepo(async (repo) => {
    writeStub(repo.dir);
    setHoldAt(repo.dir, 'implement#1');
    const running = sailProcess(repo.dir, repo.env, ['FAKE-1']);
    try {
      expect(await until('the run holding at implement#1', () => heldRuns(repo.dir).length === 1)).toBe(
        'the run holding at implement#1',
      );
      const runId = heldRuns(repo.dir)[0]?.runId ?? '';
      const lease = leasesIn(repo);
      const leasesDir = join(repo.dir, '.sail-runs', 'fake', 'leases');
      const leaseName = readdirSync(leasesDir).find((name) => name.endsWith('.json'));
      expect(leaseName).toBeString();
      const refused = await spawned(repo, 'resume', runId);
      expect(refused.stderr).toContain(
        `If process ${running.pid} is not sail, it took the pid of the run's ended process`,
      );
      expect(refused.stderr).toContain(`remove the lease file ${join(leasesDir, leaseName ?? '')}, then resume it`);
      expect({
        code: refused.code,
        said: refused.stderr.includes(`is still running, in process ${running.pid}`),
        status: readStatus(join(repo.dir, '.sail-runs', runId)),
        lease: leasesIn(repo),
      }).toEqual({ code: EXIT_REFUSED, said: true, status: { status: 'running' }, lease });
    } finally {
      releaseHeld(repo.dir);
      if (running.exitCode === null) killOne(running.pid, 'SIGKILL');
      await running.exited;
    }
  });
}, 150_000);

test('sail resume refuses a run whose lease another run took over once its process died, naming that run', async () => {
  await withTempRepo(async (repo) => {
    writeStub(repo.dir);
    setSleepAt(repo.dir, 'implement#1');
    const running = Bun.spawn([process.execPath, MAIN, 'FAKE-1'], {
      cwd: repo.dir,
      env: repo.env,
      stdin: 'ignore',
      stdout: 'ignore',
      stderr: 'ignore',
    });
    const sleeping = await whenSleeping(repo.dir);
    const crashed = runIdIn(repo.dir);
    running.kill('SIGKILL');
    await running.exited;
    for (const pid of sleeping) process.kill(pid, 'SIGKILL');
    const second = await spawned(repo, 'FAKE-1', '--force', '--until', 'spec');
    const took = runIds(repo.dir).find((id) => id !== crashed) ?? '';
    const refused = await spawned(repo, 'resume', crashed);
    expect({
      codes: [second.code, refused.code],
      said: refused.stderr.includes(`the branch ${STUB_BRANCH} is leased by run ${took} (suspended)`),
    }).toEqual({ codes: [EXIT_SUSPENDED, EXIT_REFUSED], said: true });
  });
}, 30_000);

test.each<[string, (repo: TempRepo, dir: string) => void, string]>([
  [
    'whose workspace is gone',
    (repo, dir) => {
      Bun.spawnSync(['git', 'worktree', 'remove', '--force', join(dir, 'workspace')], { cwd: repo.dir, env: repo.env });
    },
    'the workspace is gone (invalid)',
  ],
  [
    "whose workspace's HEAD was reset off its base",
    (repo, dir) => {
      const workspace = join(dir, 'workspace');
      if (!existsSync(workspace)) return;
      const git = (...args: string[]) =>
        Bun.spawnSync(['git', ...args], { cwd: workspace, env: repo.env })
          .stdout.toString()
          .trim();
      git('checkout', '-q', '--detach', git('commit-tree', 'HEAD^{tree}', '-m', 'orphan'));
    },
    'no longer descends from its base',
  ],
  [
    'from before runs had workspaces',
    (_, dir) => {
      const file = join(dir, 'run.json');
      const {
        branch: _branch,
        repository: _repository,
        workspace: _workspace,
        ...older
      } = JSON.parse(readFileSync(file, 'utf8'));
      chmodSync(file, 0o644);
      writeFileSync(file, `${JSON.stringify(older, null, 2)}\n`);
    },
    'started before runs had workspaces: it has no workspace to resume in',
  ],
])(
  'sail resume refuses a run %s with exit code 3, and leaves it suspended',
  async (_, spoil, said) => {
    await withTempRepo(async (repo) => {
      writeStub(repo.dir);
      const first = await spawned(repo, 'FAKE-1', '--until', 'spec');
      const runId = runIdIn(repo.dir);
      const dir = join(repo.dir, '.sail-runs', runId);
      spoil(repo, dir);
      const refused = await spawned(repo, 'resume', runId);
      expect({
        codes: [first.code, refused.code],
        said: refused.stderr.includes(said) ? said : refused.stderr,
        status: readStatus(dir).status,
      }).toEqual({ codes: [EXIT_SUSPENDED, EXIT_REFUSED], said, status: 'suspended' });
    });
  },
  30_000,
);

test("sail resume of a dispatched run loads the run's own copy of the definitions, and completes after the clone's workflow is gone", async () => {
  await withTempRepo(async (repo) => {
    const sail = writeStub(repo.dir, { testsPassAt: 1 });
    repo.git('add', '.sail');
    repo.git('commit', '-q', '-m', 'definitions');
    const runId = 'FAKE-1-01M3BWNZM08Q4T6V2XRJ5KWD3P';
    const first = await runCaptured(
      ['FAKE-1', '--workflow', 'ticket-to-pr', '--dispatch', runId, '--until', 'implement'],
      repo.dir,
    );
    expect({ code: first.code, stderr: first.stderr }).toEqual({ code: EXIT_SUSPENDED, stderr: '' });
    rmSync(join(sail, 'workflows', 'ticket-to-pr'), { recursive: true });
    const resumed = await runCaptured(['resume', runId], repo.dir);
    expect({ code: resumed.code, stderr: resumed.stderr }).toEqual({ code: EXIT_OK, stderr: '' });
    expect(readStatus(join(repo.dir, '.sail-runs', runId))).toEqual({ status: 'completed' });
  });
});

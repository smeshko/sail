// `sail FAKE-1 --until spec` on the claude-code harness, offline: a copy of the fixture repository whose harness is the
// built-in claude-code on a scripted query(), so the run, its files and its events are what a real session gives,
// with no Claude Code process and no network.
import { expect, test } from 'bun:test';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { EXIT_FAILED, EXIT_SUSPENDED } from '../../src/cli/exit-codes';
import { readJournal } from '../../src/engine/journal';
import { readStatus } from '../../src/engine/run-dir';
import { formatIssue, validateRunDir } from '../../src/engine/schemas';
import { readEvents } from '../../src/events/consumers/ndjson';
import { runDirIn } from '../helpers/agent-fixture';
import {
  assistantToolUse,
  COST,
  INVALID_KEY,
  init,
  invalidKeySession,
  resultSuccess,
  SCRIPTED_ADAPTER,
  SESSION_ID,
  type Stream,
  specSession,
  toolResult,
  writeScriptedClaudeCode,
  writeScriptedStreams,
} from '../helpers/claude-code';
import { copyFixture } from '../helpers/fixture';
import { fakeInterrupts, runCaptured } from '../helpers/run-captured';
import { copyRun } from '../helpers/stub-workflow';
import { withTempRepo } from '../helpers/temp-repo';

/** What the fixture's spec stage submits. */
const SPEC = { summary: 'Add a --shout flag to greet.', tasks: [{ title: 'Add the flag', files: ['src/greet.ts'] }] };

/** Runs `sail FAKE-1 --until spec` in a copy of the fixture whose harness plays `stream`, and reads back the run. */
async function runSpec(stream: Stream) {
  return withTempRepo(async (repo) => {
    copyFixture(repo.dir);
    writeScriptedClaudeCode(repo.dir, [stream]);
    const env = { ...repo.env, ANTHROPIC_API_KEY: 'offline-test' };
    const { code, stderr } = await runCaptured(['FAKE-1', '--until', 'spec', '-q'], repo.dir, { env });
    // A run refused before it opened leaves no run directory: the exit code and stderr say why.
    const runs = join(repo.dir, '.sail-runs');
    if (!existsSync(runs) || readdirSync(runs).every((name) => name === 'fake')) {
      return {
        code,
        stderr,
        status: undefined,
        header: {},
        result: {},
        spec: null,
        sessionLog: null,
        events: [],
        issues: [],
      };
    }
    const dir = runDirIn(repo.dir);
    const call = join(dir, '01-spec', 'call-1');
    const read = (name: string) => (existsSync(join(call, name)) ? readFileSync(join(call, name), 'utf8') : null);
    return {
      code,
      stderr,
      status: readStatus(dir),
      header: JSON.parse(readFileSync(join(dir, 'run.json'), 'utf8')),
      result: JSON.parse(read('result.json') ?? '{}'),
      spec: read('spec.md'),
      sessionLog: read('session.log'),
      events: readEvents(dir).filter((event) => 'key' in event && event.key === 'spec#1'),
      issues: validateRunDir(dir).issues.map(formatIssue),
    };
  });
}

test('sail FAKE-1 --until spec on claude-code suspends after spec with spec.md, session.log, its session id, cost and cache tokens', async () => {
  const run = await runSpec(specSession(SPEC));
  expect({ code: run.code, stderr: run.stderr }).toEqual({ code: EXIT_SUSPENDED, stderr: '' });
  expect(run.header.adapters.harness).toEqual({
    use: SCRIPTED_ADAPTER,
    origin: 'repo:.sail/adapters/claude-code-scripted.ts',
    versions: { '@anthropic-ai/claude-agent-sdk': '0.3.282' },
  });
  expect({ spec: run.spec, outcome: run.result.outcome, output: run.result.output }).toEqual({
    spec: '# Spec\n',
    outcome: 'done',
    output: SPEC,
  });
  expect({ adapter: run.result.harness.adapter, sessionId: run.result.harness.sessionId }).toEqual({
    adapter: 'claude-code',
    sessionId: SESSION_ID,
  });
  expect(run.result.usage).toEqual({
    inputTokens: 120,
    cacheReadTokens: 5000,
    cacheWriteTokens: 800,
    outputTokens: 340,
    costUsd: COST,
  });
  expect(run.sessionLog?.split('\n').slice(0, 2)).toEqual([
    `session ${SESSION_ID} on claude-sonnet-5`,
    'tool Write {"file_path":"spec.md"} [tool-1]',
  ]);
  expect(run.sessionLog).toEndWith('ended: done\n');
  const last = run.events.findLast((event) => event.type === 'usage:update');
  expect(last?.type === 'usage:update' ? last.costUsdSoFar : undefined).toBe(COST);
}, 60_000);

test("an invalid API key fails the run with stage_error and exit 1, keeping the provider's message in error:harness", async () => {
  const run = await runSpec(invalidKeySession());
  expect({ code: run.code, status: run.status }).toEqual({
    code: EXIT_FAILED,
    status: { status: 'failed', stopReason: 'stage_error' },
  });
  const failures = run.events.flatMap((event) => (event.type === 'error:harness' ? [event.message] : []));
  expect(failures).toEqual([`the session failed: ${INVALID_KEY}`]);
  expect(run.result.errors).toEqual([{ reason: 'harness', message: `the session failed: ${INVALID_KEY}` }]);
}, 60_000);

/** The spec session with a Bash call first that the spec stage's permissions deny, then the session's own work. */
const deniedThenSpec = (): Stream => [
  init({ tools: ['Read', 'Glob', 'Grep', 'Write', 'Edit', 'Bash'] }),
  assistantToolUse('m0', 'tool-0', 'Bash', { command: 'tail README.md' }, { usage: { input: 20, output: 10 } }),
  { act: 'preToolUse', tool: 'Bash', input: { command: 'tail README.md' }, toolUseID: 'tool-0' },
  toolResult('tool-0', { isError: true }),
  ...specSession(SPEC).slice(1),
];

// biome-ignore format: TDD-PENDING TASK-007
test
  .skip // TDD-PENDING TASK-007
  ("a call the spec stage's commands deny is recorded in the run, and the session recovers to submit", async () => {
  const run = await runSpec(deniedThenSpec());
  expect({
    code: run.code,
    stderr: run.stderr,
    outcome: run.result.outcome,
    denials: run.result.harness.denials,
  }).toEqual({
    code: EXIT_SUSPENDED,
    stderr: '',
    outcome: 'done',
    denials: 1,
  });
  const around = run.events.filter(
    (event) =>
      ['tool:start', 'permission:denied', 'tool:end'].includes(event.type) &&
      'callId' in event &&
      event.callId === 'tool-0',
  );
  expect(
    around.map((event) =>
      event.type === 'permission:denied'
        ? { ...event, reason: typeof event.reason }
        : event.type === 'tool:end'
          ? `${event.type} ${event.status}`
          : event.type,
    ),
  ).toEqual([
    'tool:start',
    expect.objectContaining({
      type: 'permission:denied',
      key: 'spec#1',
      callId: 'tool-0',
      tool: 'Bash',
      rule: 'commands',
      permissions: { commands: ['git log *', 'git diff *'] },
      reason: 'string',
    }),
    'tool:end denied',
  ]);
  expect(run.sessionLog?.split('\n').filter((line) => line.startsWith('denied '))).toEqual([
    expect.stringMatching(/^denied Bash \[tool-0\] by commands: .+/),
  ]);
  expect(run.issues).toEqual([]);
}, 60_000);

/** Waits until `ready()` holds, or `ms` passes. */
async function until(ready: () => boolean, ms = 10_000): Promise<void> {
  const deadline = performance.now() + ms;
  while (!ready() && performance.now() < deadline) await Bun.sleep(20);
}

/** `'none'` once the process group `pgid` is gone, within `ms`; else `'left'`, after killing it. */
async function groupLeft(pgid: number, ms = 3_000): Promise<'none' | 'left'> {
  const gone = () => {
    try {
      process.kill(-pgid, 0);
      return false;
    } catch (error) {
      // macOS answers EPERM while the group's last members exit.
      return (error as NodeJS.ErrnoException).code === 'ESRCH';
    }
  };
  await until(gone, ms);
  if (gone()) return 'none';
  try {
    process.kill(-pgid, 'SIGKILL');
  } catch {
    // Gone after all.
  }
  return 'left';
}

/** Waits until the run in `repoDir` has an event of `type`, or `ms` passes: false then. */
async function eventIn(repoDir: string, type: string, ms = 20_000): Promise<boolean> {
  const deadline = performance.now() + ms;
  while (performance.now() < deadline) {
    const runs = join(repoDir, '.sail-runs');
    const ids = existsSync(runs) ? readdirSync(runs).filter((name) => name !== 'fake') : [];
    const dir = ids[0] === undefined ? undefined : join(runs, ids[0]);
    if (dir !== undefined && existsSync(join(dir, 'events.ndjson')) && readEvents(dir).some((e) => e.type === type)) {
      return true;
    }
    await Bun.sleep(20);
  }
  return false;
}

// biome-ignore format: TDD-PENDING TASK-007
test
  .skip // TDD-PENDING TASK-007
  ('Ctrl-C during the spec session suspends the run interrupted with spec#1 unjournaled, and sail resume runs it again to done', async () => {
  await withTempRepo(async (repo) => {
    copyFixture(repo.dir);
    // The session's stand-in process tree writes its group's id where the test can find it.
    const pidFile = join(repo.dir, 'claude-code.pid');
    const tree = {
      act: 'spawn',
      command: '/bin/sh',
      args: ['-c', `echo $$ > ${pidFile}; sleep 30 & sleep 30`],
    } as const;
    writeScriptedClaudeCode(repo.dir, [[init(), tree, { act: 'waitForAbort' }]]);
    const interrupts = fakeInterrupts();
    const env = { ...repo.env, ANTHROPIC_API_KEY: 'offline-test' };
    const running = runCaptured(['FAKE-1', '--until', 'spec', '-q'], repo.dir, { env, ...interrupts });
    const started = await eventIn(repo.dir, 'harness:session_start');
    await until(() => existsSync(pidFile) && readFileSync(pidFile, 'utf8').endsWith('\n'));
    interrupts.interrupt();
    const first = await running;
    const pgid = existsSync(pidFile) ? Number(readFileSync(pidFile, 'utf8')) : undefined;
    const orphaned = pgid === undefined ? 'never spawned' : await groupLeft(pgid);
    const runId = runDirIn(repo.dir).split('/').at(-1) ?? '';
    const before = readStatus(runDirIn(repo.dir));
    const unjournaled = readJournal(runDirIn(repo.dir)).entries.map((entry) => entry.key);

    // Bun can't reload a run's modules, so the resume runs from a copy, as a new process would. The resumed spec#1
    // submits; the next agent session, implement's, blocks, which ends the run.
    writeScriptedStreams(repo.dir, [
      specSession(SPEC),
      [init(), resultSuccess({ structured: { outcome: 'blocked', reason: 'Not today.' } })],
    ]);
    await withTempRepo(async (copy) => {
      copyRun(repo.dir, copy.dir);
      const resumed = await runCaptured(['resume', runId, '-q'], copy.dir, {
        env: { ...copy.env, ANTHROPIC_API_KEY: 'offline-test' },
      });
      const dir = join(copy.dir, '.sail-runs', runId);
      const journal = readJournal(dir).entries.map((entry) => `${entry.key} ${entry.outcome}`);
      const sessions = readEvents(dir).flatMap((event) =>
        event.type === 'harness:session_start' && 'key' in event ? [event.key] : [],
      );
      expect({ started, code: first.code, before, unjournaled, orphaned }).toEqual({
        started: true,
        orphaned: 'none',
        code: EXIT_SUSPENDED,
        before: { status: 'suspended', stopReason: 'interrupted' },
        unjournaled: ['intake#1'],
      });
      const call = join(dir, '01-spec', 'call-1');
      const tried = JSON.parse(readFileSync(join(call, 'try-2', 'result.json'), 'utf8'));
      expect({
        stderr: resumed.stderr,
        code: resumed.code,
        status: readStatus(dir) as unknown,
        journal,
        sessions,
        secondTry: [tried.try, tried.outcome],
      }).toEqual({
        stderr: '',
        code: EXIT_FAILED,
        status: { status: 'failed', stopReason: 'workflow_failed' },
        journal: ['intake#1 passed', 'spec#1 done', 'implement#1 blocked'],
        sessions: ['spec#1', 'spec#1', 'implement#1'],
        secondTry: [2, 'done'],
      });
      expect(validateRunDir(dir).issues.map(formatIssue)).toEqual([]);
    });
  });
}, 60_000);

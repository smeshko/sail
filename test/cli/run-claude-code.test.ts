// `sail FAKE-1 --until spec` on the claude-code harness, offline: a copy of the fixture repository whose harness is the
// built-in claude-code on a scripted query(), so the run, its files and its events are what a real session gives,
// with no Claude Code process and no network.
import { expect, test } from 'bun:test';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { EXIT_FAILED, EXIT_SUSPENDED } from '../../src/cli/exit-codes';
import { readStatus } from '../../src/engine/run-dir';
import { readEvents } from '../../src/events/consumers/ndjson';
import { runDirIn } from '../helpers/agent-fixture';
import {
  COST,
  INVALID_KEY,
  invalidKeySession,
  SCRIPTED_ADAPTER,
  SESSION_ID,
  type Stream,
  specSession,
  writeScriptedClaudeCode,
} from '../helpers/claude-code';
import { copyFixture } from '../helpers/fixture';
import { runCaptured } from '../helpers/run-captured';
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
      return { code, stderr, status: undefined, header: {}, result: {}, spec: null, sessionLog: null, events: [] };
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
    };
  });
}

// biome-ignore format: TDD-PENDING TASK-008
test
  .skip // TDD-PENDING TASK-008
  ('sail FAKE-1 --until spec on claude-code suspends after spec with spec.md, session.log, its session id, cost and cache tokens', async () => {
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

// biome-ignore format: TDD-PENDING TASK-008
test
  .skip // TDD-PENDING TASK-008
  ("an invalid API key fails the run with stage_error and exit 1, keeping the provider's message in error:harness", async () => {
  const run = await runSpec(invalidKeySession());
  expect({ code: run.code, status: run.status }).toEqual({
    code: EXIT_FAILED,
    status: { status: 'failed', stopReason: 'stage_error' },
  });
  const failures = run.events.flatMap((event) => (event.type === 'error:harness' ? [event.message] : []));
  expect(failures).toEqual([`the session failed: ${INVALID_KEY}`]);
  expect(run.result.errors).toEqual([{ reason: 'harness', message: `the session failed: ${INVALID_KEY}` }]);
}, 60_000);

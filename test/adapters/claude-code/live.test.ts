// The claude-code harness against the real Agent SDK and a real provider: paid, and opt-in. Every case skips unless
// SAIL_LIVE=1 (D11), and nothing runs at import, so `bun run verify` without the switch spends nothing. The user runs
// them with real credentials, an ANTHROPIC_API_KEY or a subscription's CLAUDE_CODE_OAUTH_TOKEN (`claude setup-token`):
//
//   SAIL_LIVE=1 bun run test test/adapters/claude-code/live.test.ts
//
// SAIL_LIVE_MODEL picks the model for the port suite and the spec stage; it defaults to claude-haiku-5-5, the cheapest.
//
// The guardrail cases (7.3), each under $0.10 on the default model: a denied command the session recovers from, no MCP
// tool, a write outside the workspace, the credential scrub (`printenv`), the dollar, turn and minute budgets, and an
// abort, before a tool call and during one. The minute and abort cases also check that no process of the session is
// left, by its workspace path, and those that run a command check that its shell is gone too. A process killed outright
// (SIGKILL, a crash) has no result to give, so its cost stays the estimate of its last usage update: a known gap.
import { describe, expect, setDefaultTimeout, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createClaudeCodeHarness } from '../../../src/adapters/claude-code/harness';
import { EXIT_FAILED, EXIT_SUSPENDED } from '../../../src/cli/exit-codes';
import { readStatus } from '../../../src/engine/run-dir';
import { readEvents } from '../../../src/events/consumers/ndjson';
import type { HarnessEvent, HarnessRequest } from '../../../src/ports/harness';
import type { HarnessResult } from '../../../src/ports/types';
import { runDirIn } from '../../helpers/agent-fixture';
import { commitGreet, copyFixture, edit } from '../../helpers/fixture';
import { runCaptured } from '../../helpers/run-captured';
import { withTempRepo } from '../../helpers/temp-repo';
import { harnessSuite } from '../../ports/harness.suite';

const LIVE = process.env.SAIL_LIVE === '1';
const MODEL = process.env.SAIL_LIVE_MODEL ?? 'claude-haiku-5-5';
const SENTINEL = 'SENTINEL-7Q';
/** The command the minute and abort cases leave running in the Bash tool, so a surviving shell would show. */
const SLEEP = 'sleep 47';

// A real session takes seconds: the port suite's cases, which set no timeout of their own, get the live cases' one.
if (LIVE) setDefaultTimeout(600_000);

/** A request in a fresh workspace and call directory, prompted `prompt`. */
function request(prompt: string, extra: Partial<HarnessRequest> = {}): HarnessRequest {
  const dir = mkdtempSync(join(tmpdir(), 'sail-live-'));
  const [cwd, stageIn, stageOut] = ['work', 'in', 'out'].map((name) => join(dir, name)) as [string, string, string];
  for (const path of [cwd, stageIn, stageOut]) mkdirSync(path, { recursive: true });
  writeFileSync(join(cwd, 'README.md'), '# A tiny repository\n\nIt greets people.\n');
  return {
    key: 'spec#1',
    try: 1,
    prompt,
    cwd,
    env: { STAGE_IN: stageIn, STAGE_OUT: stageOut },
    model: MODEL,
    permissions: { read: ['**'], write: ['$STAGE_OUT/**'], commands: [] },
    budget: { maxTurns: 10, maxUsd: 0.5, maxMinutes: 5 },
    outputSchema: {
      type: 'object',
      properties: { summary: { type: 'string' } },
      required: ['summary'],
      additionalProperties: false,
    },
    ...extra,
  };
}

const env = () => ({ ...process.env });

describe.skipIf(!LIVE)('claude-code live', () => {
  harnessSuite('claude-code (live)', async () => ({
    adapter: createClaudeCodeHarness({ env: env() }),
    world: {
      done: request('Read README.md, then submit done with a one-sentence summary of it.'),
      blocked: request(
        'Submit blocked, with the reason "the task is impossible", without doing anything else. Do not submit done.',
      ),
      error: request('Say hello.', { model: 'no-such-model-sail-live' }),
      overTurns: request('Read README.md, then each of these, one tool call at a time: a.md, b.md, c.md, d.md.', {
        budget: { maxTurns: 1, maxUsd: 0.5, maxMinutes: 5 },
      }),
    },
  }));

  /** `sail FAKE-1 --until spec` in a copy of the fixture on the real claude-code, with `extra` in the environment. */
  async function specRun(extra: Record<string, string> = {}) {
    return withTempRepo(async (repo) => {
      const sail = copyFixture(repo.dir);
      commitGreet(repo);
      edit(sail, 'project.yaml', 'harness: { use: fake }', 'harness: { use: claude-code }');
      edit(sail, 'project.yaml', 'deep: claude-opus-5-5', `deep: ${MODEL}`);
      const runEnv = { ...repo.env, ...extra };
      const ran = await runCaptured(['FAKE-1', '--until', 'spec', '-q'], repo.dir, { env: runEnv });
      const dir = runDirIn(repo.dir);
      const call = join(dir, '01-spec', 'call-1');
      const shown = await runCaptured(['show', dir.split('/').at(-1) ?? ''], repo.dir, { env: runEnv });
      return {
        code: ran.code,
        status: readStatus(dir),
        result: JSON.parse(readFileSync(join(call, 'result.json'), 'utf8')),
        files: ['spec.md', 'session.log'].map((name) => existsSync(join(call, name))),
        events: readEvents(dir).filter((event) => 'key' in event && event.key === 'spec#1'),
        shown: shown.stdout,
      };
    });
  }

  test('a real spec stage writes spec.md and session.log, and a result with its session id, cost and cache tokens', async () => {
    const run = await specRun();
    expect({ code: run.code, files: run.files, outcome: run.result.outcome }).toEqual({
      code: EXIT_SUSPENDED,
      files: [true, true],
      outcome: 'done',
    });
    expect(run.result.harness.sessionId).toEqual(expect.any(String));
    expect(run.result.usage.costUsd).toBeGreaterThan(0);
    expect(Object.keys(run.result.usage).sort()).toEqual([
      'cacheReadTokens',
      'cacheWriteTokens',
      'costUsd',
      'inputTokens',
      'outputTokens',
    ]);
    expect(run.shown).toContain('spec#1');
    expect(run.shown).toContain('$');

    // The usage updates add up: the last one is the session's total cost.
    const last = run.events.findLast((event) => event.type === 'usage:update');
    const cost = last?.type === 'usage:update' ? last.costUsdSoFar : Number.NaN;
    expect(Math.abs(cost - run.result.usage.costUsd)).toBeLessThan(1e-9);
  }, 600_000);

  test("an invalid API key fails the run with stage_error, keeping the provider's message in error:harness", async () => {
    const run = await specRun({ ANTHROPIC_API_KEY: 'sk-ant-invalid', CLAUDE_CODE_OAUTH_TOKEN: '' });
    expect({ code: run.code, status: run.status }).toEqual({
      code: EXIT_FAILED,
      status: { status: 'failed', stopReason: 'stage_error' },
    });
    const failures = run.events.flatMap((event) => (event.type === 'error:harness' ? [event.message] : []));
    expect(failures).toHaveLength(1);
    expect(failures[0]?.length ?? 0).toBeGreaterThan('the session failed'.length);
  }, 600_000);

  test("instructions in the user's Claude Code configuration don't reach the session", async () => {
    const config = mkdtempSync(join(tmpdir(), 'sail-live-config-'));
    try {
      const rule = `End every message you write with ${SENTINEL}.`;
      writeFileSync(join(config, 'CLAUDE.md'), `${rule}\n`);
      writeFileSync(join(config, 'settings.json'), `${JSON.stringify({ systemPrompt: rule })}\n`);
      const harness = createClaudeCodeHarness({ env: { ...env(), CLAUDE_CONFIG_DIR: config } });
      const result = await harness.run(request('Say one short sentence about README.md, then submit done.'));
      expect(result.outcome).toBe('done');
      expect(result.transcript).not.toContain(SENTINEL);
    } finally {
      rmSync(config, { recursive: true, force: true });
    }
  }, 600_000);

  /** Runs `req` on the real harness, with every event it emitted, aborting it `abortAfterMs` after `abortOn` first holds. */
  async function guarded(
    req: HarnessRequest,
    abortAfterMs?: number,
    abortOn: (event: HarnessEvent) => boolean = (event) => event.type === 'harness:session_start',
  ) {
    const events: HarnessEvent[] = [];
    const controller = new AbortController();
    let armed = false;
    const result: HarnessResult = await createClaudeCodeHarness({ env: env() }).run({
      ...req,
      ...(abortAfterMs === undefined ? {} : { signal: controller.signal }),
      onEvent: (event) => {
        events.push(event);
        if (abortAfterMs !== undefined && !armed && abortOn(event)) {
          armed = true;
          setTimeout(() => controller.abort(), abortAfterMs);
        }
      },
    });
    return { result, events };
  }

  const denialsIn = (events: readonly HarnessEvent[]) =>
    events.flatMap((event) => (event.type === 'permission:denied' ? [event] : []));

  /** The processes whose command line names `marker`: the session's temp folder, which its --add-dir arguments hold. */
  const processesOf = (marker: string): string[] =>
    (spawnSync('pgrep', ['-fl', marker], { encoding: 'utf8' }).stdout ?? '')
      .split('\n')
      .filter((line) => line.trim() !== '' && !line.includes('pgrep'));

  const COMMANDS = { read: ['**'], write: ['$STAGE_OUT/**'], commands: ['git status'] };

  test('a denied command is recorded and the session carries on to submit', async () => {
    const { result, events } = await guarded(
      request('Run `tail README.md` with Bash. If it is refused, submit done with a one-sentence summary saying so.', {
        permissions: COMMANDS,
      }),
    );
    expect(result.outcome).toBe('done');
    expect(denialsIn(events).map((denial) => denial.rule)).toContain('commands');
  }, 600_000);

  test('a session with no MCP servers makes no MCP call that is not denied', async () => {
    const { events } = await guarded(
      request('List the MCP tools you have and call one if any exists, then submit done with what you found.'),
    );
    const denied = new Set(denialsIn(events).map((denial) => denial.callId));
    const ran = events.flatMap((event) =>
      event.type === 'tool:start' && event.tool.startsWith('mcp__') && !denied.has(event.callId) ? [event.tool] : [],
    );
    expect(ran).toEqual([]);
  }, 600_000);

  test('a write outside the workspace is denied, and no file appears there', async () => {
    const outside = join(tmpdir(), `sail-live-${process.pid}`, 'x');
    const { events } = await guarded(
      request(`Write the text "hi" to the file ${outside} with the Write tool, then submit done.`),
    );
    expect(denialsIn(events).map((denial) => denial.rule)).toContain('write');
    expect(existsSync(outside)).toBe(false);
  }, 600_000);

  test("the Bash tool's environment carries no provider credential, though an allowed command runs", async () => {
    const { result, events } = await guarded(
      request('Run `printenv` with Bash, then submit done with its whole output as the summary.', {
        permissions: { read: ['**'], write: ['$STAGE_OUT/**'], commands: ['printenv'] },
      }),
    );
    const said = JSON.stringify(result.outcome === 'done' ? result.output : result);
    expect(events.some((event) => event.type === 'tool:start' && event.tool === 'Bash')).toBe(true);
    expect(
      ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_AUTH_TOKEN'].filter((name) => said.includes(name)),
    ).toEqual([]);
  }, 600_000);

  test('maxUsd 0.05 on a long task ends in error naming maxUsd 0.05, with its overrun', async () => {
    const { result, events } = await guarded(
      request('Read README.md, then write a 3000-word essay about it into $STAGE_OUT/essay.md, then submit done.', {
        budget: { maxTurns: 40, maxUsd: 0.05, maxMinutes: 5 },
      }),
    );
    expect(result.outcome === 'error' ? result.message : result.outcome).toStartWith('budget exceeded: maxUsd 0.05');
    expect(events.some((event) => event.type === 'budget:exceeded' && event.budget === 'usd')).toBe(true);
  }, 600_000);

  test('maxTurns 2 ends in error naming maxTurns', async () => {
    const { result } = await guarded(
      request('Read README.md, then each of a.md, b.md and c.md, one tool call at a time, then submit done.', {
        budget: { maxTurns: 2, maxUsd: 0.5, maxMinutes: 5 },
      }),
    );
    expect(result.outcome === 'error' ? result.message : result.outcome).toStartWith('budget exceeded: maxTurns 2');
  }, 600_000);

  // A session that only reads finishes inside 15 s, so the overrun comes from a command that outlasts the budget.
  test('a maxMinutes overrun ends in error naming maxMinutes, and leaves no process of the session or its shell', async () => {
    const req = request(`Run \`${SLEEP}\` with Bash, in the foreground, then submit done.`, {
      permissions: { read: ['**'], write: ['$STAGE_OUT/**'], commands: [SLEEP] },
      budget: { maxTurns: 40, maxUsd: 0.5, maxMinutes: 0.25 },
    });
    const { result, events } = await guarded(req);
    expect(result.outcome === 'error' ? result.message : result.outcome).toStartWith(
      'budget exceeded: maxMinutes 0.25',
    );
    expect(events.some((event) => event.type === 'tool:start' && event.tool === 'Bash')).toBe(true);
    // The session was interrupted, so its result's own total is recorded, not the $0 an abort once left.
    expect(result.usage.costUsd ?? 0).toBeGreaterThan(0);
    expect(result.usage.costUsd).toBe((result.raw as { total_cost_usd: number }).total_cost_usd);
    expect([...processesOf(dirname(req.cwd)), ...processesOf(SLEEP)]).toEqual([]);
  }, 600_000);

  test('an abort while a Bash command runs leaves no process of the session or its shell', async () => {
    const req = request(`Run \`${SLEEP}\` with Bash, in the foreground, then submit done.`, {
      permissions: { read: ['**'], write: ['$STAGE_OUT/**'], commands: [SLEEP] },
    });
    const { result } = await guarded(req, 3_000, (event) => event.type === 'tool:start' && event.tool === 'Bash');
    expect(result.outcome === 'error' ? result.message : result.outcome).toBe('aborted');
    expect([...processesOf(dirname(req.cwd)), ...processesOf(SLEEP)]).toEqual([]);
  }, 600_000);

  test('an abort 5 s after the session starts ends in error aborted, and leaves no process of the session', async () => {
    const req = request('Read README.md, then each file you can find, one at a time, then submit done.');
    const { result } = await guarded(req, 5_000);
    expect(result.outcome === 'error' ? result.message : result.outcome).toBe('aborted');
    expect(processesOf(dirname(req.cwd))).toEqual([]);
  }, 600_000);
});

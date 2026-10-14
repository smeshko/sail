// The claude-code harness against the real Agent SDK and a real provider: paid, and opt-in. Every case skips unless
// SAIL_LIVE=1 (D11), and nothing runs at import, so `bun run verify` without the switch spends nothing. The user runs
// them with real credentials, an ANTHROPIC_API_KEY or a subscription's CLAUDE_CODE_OAUTH_TOKEN (`claude setup-token`):
//
//   SAIL_LIVE=1 bun run test test/adapters/claude-code/live.test.ts
//
// SAIL_LIVE_MODEL picks a cheaper model for the port suite and the spec stage; it defaults to the fixture's `default`.
import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createClaudeCodeHarness } from '../../../src/adapters/claude-code/harness';
import { EXIT_FAILED, EXIT_SUSPENDED } from '../../../src/cli/exit-codes';
import { readStatus } from '../../../src/engine/run-dir';
import { readEvents } from '../../../src/events/consumers/ndjson';
import type { HarnessRequest } from '../../../src/ports/harness';
import { runDirIn } from '../../helpers/agent-fixture';
import { copyFixture, edit } from '../../helpers/fixture';
import { runCaptured } from '../../helpers/run-captured';
import { withTempRepo } from '../../helpers/temp-repo';
import { harnessSuite } from '../../ports/harness.suite';

const LIVE = process.env.SAIL_LIVE === '1';
const MODEL = process.env.SAIL_LIVE_MODEL ?? 'claude-sonnet-5';
const SENTINEL = 'SENTINEL-7Q';

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
});

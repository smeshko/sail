// The pi harness against the real pi SDK and a real provider: paid, and opt-in. Every case skips unless SAIL_LIVE=1,
// and nothing runs at import, so `bun run verify` without the switch spends nothing. Run them with the provider's key
// set (GROQ_API_KEY for the default model):
//
//   SAIL_LIVE=1 bun run test test/adapters/pi/live.test.ts
//
// SAIL_LIVE_PI_MODEL picks pi's `provider/model` for every case; it defaults to a small Groq model.
import { describe, expect, setDefaultTimeout, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createPiHarness } from '../../../src/adapters/pi/harness';
import { readStatus } from '../../../src/engine/run-dir';
import type { HarnessEvent, HarnessRequest } from '../../../src/ports/harness';
import type { HarnessResult } from '../../../src/ports/types';
import { runDirIn } from '../../helpers/agent-fixture';
import { commitGreet, copyFixture, edit } from '../../helpers/fixture';
import { runCaptured } from '../../helpers/run-captured';
import { withTempRepo } from '../../helpers/temp-repo';
import { harnessSuite } from '../../ports/harness.suite';

const LIVE = process.env.SAIL_LIVE === '1';
const MODEL = process.env.SAIL_LIVE_PI_MODEL ?? 'groq/llama-3.3-70b-versatile';
const PROVIDER = MODEL.split('/')[0] ?? 'groq';
const SLEEP = 'sleep 47';

if (LIVE) setDefaultTimeout(600_000);

function request(prompt: string, extra: Partial<HarnessRequest> = {}): HarnessRequest {
  const dir = mkdtempSync(join(tmpdir(), 'sail-live-pi-'));
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

describe.skipIf(!LIVE)('pi live', () => {
  harnessSuite('pi (live)', async () => ({
    adapter: createPiHarness({ env: env() }),
    world: {
      done: request('Read README.md, then submit done with a one-sentence summary of it.'),
      blocked: request(
        'Submit blocked, with the reason "the task is impossible", without doing anything else. Do not submit done.',
      ),
      error: request('Say hello.', { model: `${PROVIDER}/no-such-model-sail-live` }),
      overTurns: request('Read README.md, then each of these, one tool call at a time: a.md, b.md, c.md, d.md.', {
        budget: { maxTurns: 1, maxUsd: 0.5, maxMinutes: 5 },
      }),
    },
  }));

  async function guarded(req: HarnessRequest, abortAfterMs?: number, abortOn?: (event: HarnessEvent) => boolean) {
    const events: HarnessEvent[] = [];
    const controller = new AbortController();
    let armed = false;
    const result: HarnessResult = await createPiHarness({ env: env() }).run({
      ...req,
      ...(abortAfterMs === undefined ? {} : { signal: controller.signal }),
      onEvent: (event) => {
        events.push(event);
        if (abortAfterMs !== undefined && !armed && (abortOn?.(event) ?? event.type === 'harness:session_start')) {
          armed = true;
          setTimeout(() => controller.abort(), abortAfterMs);
        }
      },
    });
    return { result, events };
  }

  const denialsIn = (events: readonly HarnessEvent[]) =>
    events.flatMap((event) => (event.type === 'permission:denied' ? [event] : []));

  const processesOf = (marker: string): string[] =>
    (spawnSync('pgrep', ['-fl', marker], { encoding: 'utf8' }).stdout ?? '')
      .split('\n')
      .filter((line) => line.trim() !== '' && !line.includes('pgrep'));

  test('a denied command is recorded and the session carries on to submit', async () => {
    const { result, events } = await guarded(
      request('Run `tail README.md` with bash. If it is refused, submit done with a one-sentence summary saying so.', {
        permissions: { read: ['**'], write: ['$STAGE_OUT/**'], commands: ['git status'] },
      }),
    );
    expect(result.outcome).toBe('done');
    expect(denialsIn(events).map((denial) => denial.rule)).toContain('commands');
  });

  test('a write outside the workspace is denied, and no file appears there', async () => {
    const outside = join(tmpdir(), `sail-live-pi-${process.pid}`, 'x');
    const { events } = await guarded(request(`Write the text "hi" to the file ${outside}, then submit done.`));
    expect(denialsIn(events).map((denial) => denial.rule)).toContain('write');
    expect(existsSync(outside)).toBe(false);
  });

  test('maxUsd 0.001 ends in error naming maxUsd, and maxTurns 2 naming maxTurns', async () => {
    const usd = await guarded(
      request('Read README.md, then write a 3000-word essay about it into $STAGE_OUT/essay.md, then submit done.', {
        budget: { maxTurns: 40, maxUsd: 0.001, maxMinutes: 5 },
      }),
    );
    const turns = await guarded(
      request('Read README.md, then each of a.md, b.md and c.md, one tool call at a time, then submit done.', {
        budget: { maxTurns: 2, maxUsd: 0.5, maxMinutes: 5 },
      }),
    );
    const text = (result: HarnessResult) => (result.outcome === 'error' ? result.message : result.outcome);
    expect([text(usd.result), text(turns.result)]).toEqual([
      expect.stringContaining('budget exceeded: maxUsd'),
      expect.stringContaining('budget exceeded: maxTurns 2'),
    ]);
  });

  test('an abort while a bash command runs leaves no process of the session or its shell', async () => {
    const req = request(`Run \`${SLEEP}\` with bash, in the foreground, then submit done.`, {
      permissions: { read: ['**'], write: ['$STAGE_OUT/**'], commands: [SLEEP] },
    });
    const { result } = await guarded(req, 3_000, (event) => event.type === 'tool:start' && event.tool === 'bash');
    expect(result.outcome === 'error' ? result.message : result.outcome).toBe('aborted');
    expect([...processesOf(dirname(req.cwd)), ...processesOf(SLEEP)]).toEqual([]);
  });

  test('the fixture repository’s ticket-to-pr runs to completed on use: pi', async () => {
    await withTempRepo(async (repo) => {
      const sail = copyFixture(repo.dir);
      commitGreet(repo);
      edit(sail, 'project.yaml', 'harness: { use: fake }', `harness: { use: pi, provider: ${PROVIDER} }`);
      edit(sail, 'project.yaml', 'default: claude-sonnet-5', `default: ${MODEL}`);
      edit(sail, 'project.yaml', 'deep: claude-opus-5-5', `deep: ${MODEL}`);
      await runCaptured(['FAKE-1', '-q'], repo.dir, { env: { ...repo.env, ...env() } });
      expect(readStatus(runDirIn(repo.dir)).status).toBe('completed');
    });
  });
});

// The fake Harness: the port suite over an inline script, then what only the fake does: answers picked by key and try
// with no state kept, files written into $STAGE_OUT, and the events of a session (D2, D6, D13).
import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { createFakeHarness, type HarnessScript, type ScriptedAnswer } from '../../../src/adapters/fake/harness';
import type { HarnessEvent, HarnessRequest } from '../../../src/ports/harness';
import type { HarnessResult } from '../../../src/ports/types';
import { captureEvents } from '../../helpers/ports';
import { harnessSuite } from '../../ports/harness.suite';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'sail-fake-harness-'));
  dirs.push(dir);
  return dir;
}

/** A call directory to write into: `<temp>/out`, so its parent is a place an escaping file could land. */
function stageOut(): string {
  const out = join(tempDir(), 'out');
  mkdirSync(out);
  return out;
}

/** A request for call `key`, try `tryNumber`, with its own STAGE_OUT unless `env` is given. */
function request(key: string, tryNumber = 1, env?: Record<string, string>): HarnessRequest {
  return {
    key,
    try: tryNumber,
    prompt: 'Write the spec.',
    cwd: tempDir(),
    env: env ?? { STAGE_IN: tempDir(), STAGE_OUT: stageOut() },
    model: 'fake-model',
    permissions: { read: ['**'], write: ['$STAGE_OUT/**'], commands: [] },
    budget: { maxTurns: 5, maxUsd: 1, maxMinutes: 5 },
    outputSchema: { type: 'object' },
  };
}

const done = (output: unknown): ScriptedAnswer => ({ outcome: 'done', output });

/** A result as one value: a done result's output, or `<outcome>: <reason or message>`. */
function summary(result: HarnessResult): unknown {
  if (result.outcome === 'done') return result.output;
  return `${result.outcome}: ${result.outcome === 'blocked' ? result.reason : result.message}`;
}

/** Each event's type, with a usage update's turn and a message's text. */
const labels = (events: readonly HarnessEvent[]): string[] =>
  events.map((event) => {
    if (event.type === 'usage:update') return `usage:update ${event.turn}`;
    if (event.type === 'agent:message') return `agent:message ${event.text}`;
    return event.type;
  });

const SUITE: HarnessScript = {
  spec: [
    {
      outcome: 'done',
      output: { summary: 'Add a --shout flag.' },
      files: { 'spec.md': '# Spec\n' },
      messages: ['Spec written.'],
      turns: 2,
      usage: { costUsd: 0.25 },
    },
  ],
  review: [{ outcome: 'blocked', reason: 'The brief has no acceptance criteria.' }],
  implement: [{ outcome: 'error', message: 'model overloaded' }],
  tests: [{ outcome: 'done', output: {}, turns: 9 }],
};

harnessSuite('fake', async () => ({
  adapter: createFakeHarness({ script: SUITE }),
  world: {
    done: request('spec#1'),
    blocked: request('review#1'),
    error: request('implement#1'),
    overTurns: request('tests#1'),
  },
}));

const Spec = z.object({ summary: z.string() });
const INVALID = { summary: 3 };
const VALID = { summary: 'Add a --shout flag.' };

test('an answer scripted invalid then valid gives invalid output on try 1, and valid output from try 2 on', async () => {
  const harness = createFakeHarness({ script: { spec: [done(INVALID), done(VALID)] } });
  const outputs: unknown[] = [];
  for (const tryNumber of [1, 2, 3]) outputs.push(summary(await harness.run(request('spec#1', tryNumber))));
  expect(outputs).toEqual([INVALID, VALID, VALID]);
  expect(outputs.map((output) => Spec.safeParse(output).success)).toEqual([false, true, true]);
});

test("a call's own key comes before its stage's, and a key with no answer is an error naming it", async () => {
  const harness = createFakeHarness({
    script: { spec: [done('spec')], 'spec#2': [done('spec#2')], 'publish/describe': [done('publish/describe')] },
  });
  const answers: unknown[] = [];
  for (const key of ['spec#1', 'spec#2', 'spec#3', 'publish#1/describe', 'review#1']) {
    answers.push(summary(await harness.run(request(key))));
  }
  expect(answers).toEqual([
    'spec',
    'spec#2',
    'spec',
    'publish/describe',
    'error: fake harness: nothing scripted for review#1',
  ]);
});

test('a new instance given the same script answers a try as the first did, though it never ran the tries before', async () => {
  const script: HarnessScript = { spec: [done(INVALID), done(VALID)] };
  const resumed = await createFakeHarness({ script }).run(request('spec#1', 2));
  const first = createFakeHarness({ script });
  await first.run(request('spec#1', 1));
  const original = await first.run(request('spec#1', 2));
  expect(summary(resumed)).toEqual(VALID);
  expect(resumed).toEqual(original);
});

test("an answer's files land in STAGE_OUT, and files with no STAGE_OUT or outside it are an error", async () => {
  const harness = createFakeHarness({
    script: {
      spec: [{ outcome: 'done', output: {}, files: { 'spec.md': '# Spec\n' } }],
      review: [{ outcome: 'done', output: {}, files: { '../escape.md': 'out of bounds\n' } }],
    },
  });
  const out = stageOut();
  const written = await harness.run(request('spec#1', 1, { STAGE_OUT: out }));
  const spec = join(out, 'spec.md');
  expect([summary(written), existsSync(spec) && readFileSync(spec, 'utf8')]).toEqual([{}, '# Spec\n']);

  const nowhere = await harness.run(request('spec#1', 1, {}));
  const escaping = await harness.run(request('review#1', 1, { STAGE_OUT: out }));
  expect([summary(nowhere), escaping.outcome]).toEqual(['error: fake harness: files need STAGE_OUT', 'error']);
  expect(existsSync(join(out, '..', 'escape.md'))).toBe(false);
});

test('a script path is read on every run, and one that is not JSON is an error naming the file', async () => {
  const path = join(tempDir(), 'harness.json');
  writeFileSync(path, JSON.stringify({ spec: [done('first')] }));
  const harness = createFakeHarness({ script: path });
  const first = summary(await harness.run(request('spec#1')));
  writeFileSync(path, JSON.stringify({ spec: [done('second')] }));
  const second = summary(await harness.run(request('spec#1')));
  writeFileSync(path, '{ "spec": [');
  const broken = await harness.run(request('spec#1'));
  expect([first, second, broken.outcome]).toEqual(['first', 'second', 'error']);
  expect(String(summary(broken))).toContain(path);
});

test('an abort before the run or during its delay ends it at once as aborted, the latter after error:harness', async () => {
  const harness = createFakeHarness({ script: { spec: [{ outcome: 'done', output: {}, delayMs: 10_000 }] } });
  expect(summary(await harness.run({ ...request('spec#1'), signal: AbortSignal.abort() }))).toBe('error: aborted');

  const capture = captureEvents<HarnessEvent>();
  const controller = new AbortController();
  const started = Date.now();
  const running = harness.run({ ...request('spec#1'), signal: controller.signal, onEvent: capture.emit });
  setTimeout(() => controller.abort(), 20);
  const result = await running;
  expect(summary(result)).toBe('error: aborted');
  expect(labels(capture.events)).toContain('error:harness');
  expect(Date.now() - started).toBeLessThan(5_000);
});

test('the session id names the call, and the try after the first', async () => {
  const harness = createFakeHarness({ script: { spec: [done({})], 'publish/describe': [done({})] } });
  const runs: [string, number][] = [
    ['spec#1', 1],
    ['spec#1', 2],
    ['publish#1/describe', 1],
  ];
  const ids: string[] = [];
  for (const [key, tryNumber] of runs) ids.push((await harness.run(request(key, tryNumber))).sessionId);
  expect(ids).toEqual(['fake-session-spec-1', 'fake-session-spec-1-try-2', 'fake-session-publish-1-describe']);
});

test("a session emits its start, each message, a usage update per turn and its end, and keeps the answer's transcript and usage", async () => {
  const answer: ScriptedAnswer = {
    outcome: 'done',
    output: VALID,
    messages: ['Reading the brief.', 'Spec written.'],
    turns: 2,
    usage: { costUsd: 0.25, outputTokens: 900 },
  };
  const harness = createFakeHarness({ script: { spec: [answer], review: [done({})] } });
  const capture = captureEvents<HarnessEvent>();
  const result = await harness.run({ ...request('spec#1'), onEvent: capture.emit });
  expect(labels(capture.events)).toEqual([
    'harness:session_start',
    'agent:message Reading the brief.',
    'agent:message Spec written.',
    'usage:update 1',
    'usage:update 2',
    'harness:session_end',
  ]);
  expect([capture.events[0], capture.events.at(-1)]).toEqual([
    { type: 'harness:session_start', adapter: 'fake', sessionId: 'fake-session-spec-1', model: 'fake-model' },
    { type: 'harness:session_end', outcome: 'done' },
  ]);
  expect({ transcript: result.transcript, usage: result.usage, raw: result.raw }).toEqual({
    transcript: 'assistant: Reading the brief.\nassistant: Spec written.',
    usage: { costUsd: 0.25, outputTokens: 900 },
    raw: answer,
  });

  const bare = await harness.run(request('review#1'));
  expect({ transcript: bare.transcript, usage: bare.usage }).toEqual({ transcript: '', usage: { costUsd: 0 } });
});

test('an error answer, or one over maxTurns, ends as error with its message, after error:harness', async () => {
  const harness = createFakeHarness({
    script: {
      implement: [{ outcome: 'error', message: 'model overloaded' }],
      tests: [{ outcome: 'done', output: {}, turns: 3 }],
    },
  });
  const failed = captureEvents<HarnessEvent>();
  const error = await harness.run({ ...request('implement#1'), onEvent: failed.emit });
  const over = captureEvents<HarnessEvent>();
  const overTurns = await harness.run({
    ...request('tests#1'),
    budget: { maxTurns: 1, maxUsd: 1, maxMinutes: 5 },
    onEvent: over.emit,
  });
  expect([summary(error), summary(overTurns)]).toEqual([
    'error: model overloaded',
    'error: budget exceeded: maxTurns 1',
  ]);
  expect([labels(failed.events), labels(over.events)]).toEqual([
    ['harness:session_start', 'error:harness', 'harness:session_end'],
    ['harness:session_start', 'usage:update 1', 'error:harness', 'harness:session_end'],
  ]);
});

test('the fake declares structured output, usage, abort and a turns budget, and no permissions', () => {
  expect(createFakeHarness({ script: {} }).capabilities()).toEqual({
    structuredOutput: true,
    permissions: false,
    usage: true,
    abort: true,
    budgets: ['turns'],
  });
});

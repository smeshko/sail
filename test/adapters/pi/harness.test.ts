// The pi Harness over a scripted session: the port suite, then what the session is given, its events, the gate's
// denials, the three budgets, the process a command leaves, aborts, the recording, and failures that never reject. No
// test here starts pi: a scripted session stands in for the SDK.
import { afterAll, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPiHarness } from '../../../src/adapters/pi/harness';
import type { HarnessEvent, HarnessRequest } from '../../../src/ports/harness';
import type { HarnessResult } from '../../../src/ports/types';
import { fakeTimers } from '../../helpers/fake-timers';
import {
  agentStart,
  assistantEnd,
  codexJwt,
  fakeKeychain,
  PI_MODEL,
  PI_SESSION_ID,
  type Step,
  scriptedSessions,
  toolEnd,
  toolStart,
  turnEnd,
} from '../../helpers/pi';
import { captureEvents, eventIssues } from '../../helpers/ports';
import { harnessSuite } from '../../ports/harness.suite';

const base = mkdtempSync(join(tmpdir(), 'sail-test-pi-'));
afterAll(() => rmSync(base, { recursive: true, force: true }));
let made = 0;

function request(prompt = 'done', extra: Partial<HarnessRequest> = {}): HarnessRequest {
  const dir = join(base, String(++made));
  const [cwd, stageIn, stageOut] = ['work', 'in', 'out'].map((name) => join(dir, name)) as [string, string, string];
  for (const path of [cwd, stageIn, stageOut]) mkdirSync(path, { recursive: true });
  return {
    key: 'spec#1',
    try: 1,
    prompt,
    cwd,
    env: { STAGE_IN: stageIn, STAGE_OUT: stageOut, TRY: '1' },
    model: PI_MODEL,
    permissions: { read: ['**'], write: ['$STAGE_OUT/**'], commands: [] },
    budget: { maxTurns: 40, maxUsd: 2, maxMinutes: 10 },
    outputSchema: {
      type: 'object',
      properties: { summary: { type: 'string' } },
      required: ['summary'],
    },
    ...extra,
  };
}

const SPEC = { summary: 'Add a flag.' };
const message = (text: string, cost = 0.01) => assistantEnd([{ type: 'text', text }], { input: 10, output: 5, cost });
const submitted = (params: unknown): Step[] => [
  { act: 'emit', event: toolStart('s1', 'submit', {}) },
  { act: 'submit', params },
  { act: 'emit', event: toolEnd('s1', 'submit', 'Submitted.') },
  { act: 'emit', event: turnEnd() },
];
const start: Step = { act: 'emit', event: agentStart() };
const say = (text: string, cost?: number): Step => ({ act: 'emit', event: message(text, cost) });
const turn: Step = { act: 'emit', event: turnEnd() };

const SUITE: Record<string, readonly Step[]> = {
  done: [start, say('Spec written.'), ...submitted({ outcome: 'done', output: SPEC })],
  blocked: [start, say('No criteria.'), ...submitted({ outcome: 'blocked', reason: 'No acceptance criteria.' })],
  error: [start, say('Trying.'), { act: 'throw', message: 'overloaded' }],
  overTurns: [start, say('one'), turn, say('two'), turn, say('three'), turn],
};
const sessions = (extra: Record<string, readonly Step[]> = {}) =>
  scriptedSessions((prompt) => extra[prompt] ?? SUITE[prompt] ?? []);

async function play(
  prompt: string,
  extra: Partial<HarnessRequest> = {},
  scripts: Record<string, readonly Step[]> = {},
) {
  const scripted = sessions(scripts);
  const harness = createPiHarness({ env: { GROQ_API_KEY: 'gsk_x', PATH: process.env.PATH ?? '' }, ...scripted });
  const capture = captureEvents<HarnessEvent>();
  const raw: unknown[] = [];
  const result = await harness.run({ ...request(prompt, extra), onEvent: capture.emit, onRaw: (r) => raw.push(r) });
  return { result, capture, raw, scripted, types: capture.events.map((event) => event.type) };
}

const summary = (result: HarnessResult) =>
  result.outcome === 'done'
    ? result.output
    : result.outcome === 'blocked'
      ? `blocked: ${result.reason}`
      : `error: ${result.message}`;

harnessSuite(
  'pi (scripted session)',
  async () => ({
    adapter: createPiHarness({ env: {}, ...sessions() }),
    world: {
      done: request('done'),
      blocked: request('blocked'),
      error: request('error'),
      overTurns: request('overTurns', { budget: { maxTurns: 2, maxUsd: 2, maxMinutes: 10 } }),
    },
  }),
  [],
);

test('a completed session is done with the submitted output, usage, and events in order, each valid', async () => {
  const { result, capture } = await play('done');
  expect(summary(result)).toEqual(SPEC);
  expect(result).toMatchObject({
    sessionId: PI_SESSION_ID,
    usage: { inputTokens: 10, outputTokens: 5, costUsd: 0.01 },
    raw: null,
  });
  expect(capture.events.map((event) => event.type)).toEqual([
    'harness:session_start',
    'agent:message',
    'tool:start',
    'tool:end',
    'usage:update',
    'harness:session_end',
  ]);
  expect(eventIssues(capture.stamped('spec#1'))).toEqual([]);
});

test('the session is given pi’s model, the workspace, the tools its step can use, and is disposed after', async () => {
  const { scripted } = await play('done', {
    permissions: { read: ['**'], write: ['$STAGE_OUT/**'], commands: ['git status'] },
  });
  const [call] = scripted.calls;
  expect({
    model: call?.params.model,
    tools: call?.params.tools,
    submit: call?.params.submit.name,
    prompt: call?.params.systemPrompt.includes('## Where you work'),
    shell: call?.params.systemPrompt.includes('same values are in your environment'),
    disposed: call?.disposed,
  }).toEqual({
    model: PI_MODEL,
    tools: ['read', 'grep', 'find', 'ls', 'write', 'edit', 'bash'],
    submit: 'submit',
    prompt: true,
    shell: true,
    disposed: true,
  });
});

test('the session is told to submit through the submit tool, not through structured output', async () => {
  const { scripted } = await play('done');
  const prompt = scripted.calls[0]?.params.systemPrompt ?? '';
  expect({
    tool: prompt.includes('by calling the `submit` tool'),
    structured: prompt.includes('structured output'),
  }).toEqual({ tool: true, structured: false });
});

test('a step with no shell is told it has none', async () => {
  const { scripted } = await play('done');
  expect(scripted.calls[0]?.params.systemPrompt).toContain("You have no shell, so you can't read environment");
});

test('a submission that breaks the schema goes back to the model, and a valid one after it is kept', async () => {
  const { result, scripted } = await play(
    'retry',
    {},
    {
      retry: [
        start,
        say('a'),
        ...submitted({ outcome: 'done', output: { summary: 3 } }),
        ...submitted({ outcome: 'done', output: SPEC }),
      ],
    },
  );
  expect(summary(result)).toEqual(SPEC);
  expect(scripted.calls[0]?.replies[0]).toContain('The submission was not accepted');
});

test('a bash command, a write outside the step, and an unknown tool are blocked, each with its rule', async () => {
  const { result, capture, scripted } = await play(
    'denials',
    {},
    {
      denials: [
        start,
        say('trying'),
        { act: 'emit', event: toolStart('b1', 'bash', { command: 'ls' }) },
        { act: 'gate', id: 'b1', name: 'bash', input: { command: 'ls' } },
        { act: 'emit', event: toolEnd('b1', 'bash', 'blocked', true) },
        { act: 'emit', event: toolStart('w1', 'write', { path: 'src/a.ts' }) },
        { act: 'gate', id: 'w1', name: 'write', input: { path: 'src/a.ts', content: 'x' } },
        { act: 'emit', event: toolEnd('w1', 'write', 'blocked', true) },
        { act: 'emit', event: toolStart('m1', 'mystery', {}) },
        { act: 'gate', id: 'm1', name: 'mystery', input: {} },
        { act: 'emit', event: toolEnd('m1', 'mystery', 'blocked', true) },
        turn,
        ...submitted({ outcome: 'done', output: SPEC }),
      ],
    },
  );
  const denied = capture.events.flatMap((event) =>
    event.type === 'permission:denied' ? [{ callId: event.callId, rule: event.rule, tool: event.tool }] : [],
  );
  const ends = capture.events.flatMap((event) => (event.type === 'tool:end' ? [event.status] : []));
  expect({ denied, ends, blocks: scripted.calls[0]?.blocks.map((b) => (b as { block: boolean }).block) }).toEqual({
    denied: [
      { callId: 'b1', rule: 'commands', tool: 'bash' },
      { callId: 'w1', rule: 'write', tool: 'write' },
      { callId: 'm1', rule: 'tools', tool: 'mystery' },
    ],
    ends: ['denied', 'denied', 'denied', 'completed'],
    blocks: [true, true, true],
  });
  expect(capture.events.find((event) => event.type === 'harness:session_end')).toMatchObject({ denials: 3 });
  expect(summary(result)).toEqual(SPEC);
  expect(eventIssues(capture.stamped('spec#1'))).toEqual([]);
});

test('a read inside the step is let through the gate', async () => {
  const { scripted } = await play(
    'reads',
    {},
    {
      reads: [
        start,
        say('a'),
        { act: 'gate', id: 'r1', name: 'read', input: { path: 'brief.md' } },
        ...submitted({ outcome: 'done', output: SPEC }),
      ],
    },
  );
  expect(scripted.calls[0]?.blocks).toEqual([undefined]);
});

test('over maxTurns the session is aborted, and ends budget_exceeded naming maxTurns', async () => {
  const { result, capture, scripted } = await play('overTurns', { budget: { maxTurns: 2, maxUsd: 2, maxMinutes: 10 } });
  expect({
    result: summary(result),
    reason: result.outcome === 'error' ? result.reason : '',
    aborted: scripted.calls[0]?.aborted,
  }).toEqual({
    result: 'error: budget exceeded: maxTurns 2',
    reason: 'budget_exceeded',
    aborted: true,
  });
  expect(capture.events.filter((event) => event.type.startsWith('budget')).map((event) => event.type)).toEqual([
    'budget:warning',
    'budget:exceeded',
  ]);
  expect(capture.events.at(-1)).toMatchObject({ type: 'harness:session_end', reason: 'max_turns' });
});

test('a turn that submits on the last turn is done, not over', async () => {
  const { result } = await play(
    'last',
    { budget: { maxTurns: 1, maxUsd: 2, maxMinutes: 10 } },
    {
      last: [start, say('a'), ...submitted({ outcome: 'done', output: SPEC })],
    },
  );
  expect(summary(result)).toEqual(SPEC);
});

test('a session that goes on after its submission is stopped, and is done with what it submitted', async () => {
  const { result, scripted } = await play(
    'onward',
    { budget: { maxTurns: 2, maxUsd: 2, maxMinutes: 10 } },
    {
      onward: [
        start,
        say('Reading and submitting.'),
        { act: 'emit', event: toolStart('r1', 'read', { path: 'a.ts' }) },
        ...submitted({ outcome: 'done', output: SPEC }),
        say('more', 5),
        turn,
        say('and more', 5),
        turn,
      ],
    },
  );
  expect({ result: summary(result), aborted: scripted.calls[0]?.aborted }).toEqual({ result: SPEC, aborted: true });
});

test('over maxUsd the session is aborted, and ends budget_exceeded naming maxUsd', async () => {
  const { result, capture, scripted } = await play(
    'usd',
    { budget: { maxTurns: 40, maxUsd: 0.05, maxMinutes: 10 } },
    {
      usd: [start, say('costly', 0.06), { act: 'waitForAbort' }],
    },
  );
  expect({ result: summary(result), aborted: scripted.calls[0]?.aborted }).toEqual({
    result: 'error: budget exceeded: maxUsd 0.05',
    aborted: true,
  });
  expect(capture.events.some((event) => event.type === 'budget:exceeded' && event.budget === 'usd')).toBe(true);
  expect(capture.events.at(-1)).toMatchObject({ reason: 'max_budget_usd' });
});

test('maxMinutes 1 on the clock: the warning at 48 s, the overrun at 60 s aborts the session, naming maxMinutes', async () => {
  const timers = fakeTimers('2026-10-15T09:00:00.000Z');
  const scripted = sessions({ clock: [start, { act: 'waitForAbort' }] });
  const harness = createPiHarness({ env: {}, ...scripted, timers, now: () => timers.now().getTime() });
  const capture = captureEvents<HarnessEvent>();
  let started: () => void = () => undefined;
  const begun = new Promise<void>((done) => {
    started = done;
  });
  const running = harness.run({
    ...request('clock', { budget: { maxTurns: 40, maxUsd: 2, maxMinutes: 1 } }),
    onEvent: (event) => {
      capture.emit(event);
      if (event.type === 'harness:session_start') started();
    },
  });
  await begun;
  await timers.advance(48_000);
  await timers.advance(12_000);
  const result = await running;
  expect({ result: summary(result), pending: timers.pending() }).toEqual({
    result: 'error: budget exceeded: maxMinutes 1',
    pending: [],
  });
  expect(capture.events.filter((event) => event.type.startsWith('budget')).map((e) => `${e.type}`)).toEqual([
    'budget:warning',
    'budget:exceeded',
  ]);
  expect(capture.events.at(-1)).toMatchObject({ reason: 'max_minutes' });
});

test('an abort during a bash command resolves error, ends with session_end, and leaves no process', async () => {
  const pidFile = join(base, `pid-${++made}`);
  const controller = new AbortController();
  const scripted = sessions({ bash: [start, { act: 'bash', command: `echo $$ > ${pidFile}; exec sleep 30` }] });
  const harness = createPiHarness({ env: { PATH: process.env.PATH ?? '' }, ...scripted });
  const types: string[] = [];
  const running = harness.run({
    ...request('bash'),
    signal: controller.signal,
    onEvent: (event) => types.push(event.type),
  });
  const deadline = Date.now() + 5_000;
  while (!existsSync(pidFile) || readFileSync(pidFile, 'utf8').trim() === '') {
    if (Date.now() > deadline) throw new Error('the command never started');
    await Bun.sleep(10);
  }
  const pid = Number(readFileSync(pidFile, 'utf8').trim());
  controller.abort();
  const result = await running;
  const alive = (() => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  })();
  expect({ outcome: result.outcome, last: types.at(-1), alive }).toEqual({
    outcome: 'error',
    last: 'harness:session_end',
    alive: false,
  });
});

test('a session whose abort and dispose reject is still aborted, ends with session_end, and never rejects', async () => {
  const controller = new AbortController();
  const scripted = sessions({ stuck: [start, say('one'), { act: 'waitForAbort' }] });
  const harness = createPiHarness({
    env: {},
    createSession: async (params) => {
      const session = await scripted.createSession(params);
      return {
        ...session,
        subscribe: (listener) => session.subscribe(listener),
        prompt: (text) => session.prompt(text),
        abort: async () => {
          await session.abort();
          throw new Error('abort broke');
        },
        dispose: async () => {
          throw new Error('dispose broke');
        },
      };
    },
  });
  const types: string[] = [];
  const result = await harness.run({
    ...request('stuck'),
    signal: controller.signal,
    onEvent: (event) => {
      types.push(event.type);
      if (event.type === 'agent:message') controller.abort();
    },
  });
  expect({ result: summary(result), aborted: scripted.calls[0]?.aborted, last: types.at(-1) }).toEqual({
    result: 'error: aborted',
    aborted: true,
    last: 'harness:session_end',
  });
});

test('a command gets the preamble and the environment without the provider credential', async () => {
  const { scripted } = await play(
    'env',
    {},
    {
      env: [
        start,
        { act: 'bash', command: 'env > env.txt' },
        say('Listed.'),
        ...submitted({ outcome: 'done', output: SPEC }),
      ],
    },
  );
  const cwd = scripted.calls[0]?.params.cwd ?? '';
  const names = readFileSync(join(cwd, 'env.txt'), 'utf8')
    .split('\n')
    .map((line) => line.slice(0, line.indexOf('=')));
  expect({
    key: names.includes('GROQ_API_KEY'),
    path: names.includes('PATH'),
    stageOut: names.includes('STAGE_OUT'),
  }).toEqual({ key: false, path: true, stageOut: true });
});

test('every pi event goes to onRaw, and a recorder that throws changes nothing', async () => {
  const { raw, result } = await play('done');
  expect({ types: (raw as { type: string }[]).map((event) => event.type), done: summary(result) }).toEqual({
    types: ['agent_start', 'message_end', 'tool_execution_start', 'tool_execution_end', 'turn_end'],
    done: SPEC,
  });
  const scripted = sessions();
  const harness = createPiHarness({ env: {}, ...scripted });
  const again = await harness.run({
    ...request('done'),
    onRaw: () => {
      throw new Error('disk full');
    },
  });
  expect(summary(again)).toEqual(SPEC);
});

test('a session that reports no tokens is never a success', async () => {
  const { result } = await play('silent', {}, { silent: [start, ...submitted({ outcome: 'done', output: SPEC })] });
  expect(summary(result)).toBe('error: the session reported no usage');
});

test('a session that ends without submitting is an error, and a provider failure it read is its message', async () => {
  const quiet = await play('quiet', {}, { quiet: [start, say('thinking')] });
  const failed = await play(
    'failed',
    {},
    {
      failed: [
        start,
        {
          act: 'emit',
          event: assistantEnd([], undefined, { stopReason: 'error', errorMessage: '401 invalid api key' }),
        },
      ],
    },
  );
  expect([summary(quiet.result), summary(failed.result)]).toEqual([
    'error: the session ended without submitting',
    'error: the session failed: 401 invalid api key',
  ]);
});

test('a session that cannot start (no such model) is an error naming it, with no session to end', async () => {
  const harness = createPiHarness({
    env: {},
    createSession: async () => {
      throw new Error('no model groq/nope');
    },
  });
  const capture = captureEvents<HarnessEvent>();
  const result = await harness.run({ ...request('done'), onEvent: capture.emit });
  expect({ result: summary(result), types: capture.events.map((e) => e.type) }).toEqual({
    result: 'error: pi: no model groq/nope',
    types: [],
  });
});

test('an onEvent that throws fails the session, which still ends and never rejects', async () => {
  const harness = createPiHarness({ env: {}, ...sessions() });
  const result = await harness.run({
    ...request('done'),
    onEvent: (event) => {
      if (event.type === 'agent:message') throw new Error('listener broke');
    },
  });
  expect(summary(result)).toBe('error: pi: listener broke');
});

test('an onEvent that throws on the end fails a session that was done, keeping what it spent', async () => {
  const harness = createPiHarness({ env: {}, ...sessions() });
  const result = await harness.run({
    ...request('done'),
    onEvent: (event) => {
      if (event.type === 'harness:session_end') throw new Error('listener broke');
    },
  });
  expect({ text: summary(result), cost: result.usage.costUsd }).toEqual({
    text: 'error: pi: listener broke',
    cost: 0.01,
  });
});

test("an openai-codex model's session is given the Codex login's access token; another model's never asks for it", async () => {
  const scripted = sessions();
  let asked = 0;
  const harness = createPiHarness({
    env: { GROQ_API_KEY: 'gsk_x' },
    ...scripted,
    codexToken: async () => {
      asked++;
      return 'codex-access';
    },
  });
  const codex = await harness.run(request('done', { model: 'openai-codex/gpt-5.5' }));
  const groq = await harness.run(request('done'));
  expect({
    results: [summary(codex), summary(groq)],
    keys: scripted.calls.map((call) => call.params.apiKey),
    asked,
  }).toEqual({ results: [SPEC, SPEC], keys: ['codex-access', undefined], asked: 1 });
});

test('with no Codex login in the keychain an openai-codex session is the error naming sail login codex, never started', async () => {
  const scripted = sessions();
  const keychain = fakeKeychain(join(base, `keychain-${++made}`));
  const harness = createPiHarness({ env: keychain.env, ...scripted });
  const result = await harness.run(request('done', { model: 'openai-codex/gpt-5.5' }));
  expect({ text: summary(result), started: scripted.calls.length, asked: keychain.calls() }).toEqual({
    text: 'error: pi: no Codex login in the keychain: run sail login codex',
    started: 0,
    asked: ['find-generic-password -a ivo -s sail-openai-codex -w'],
  });
});

test("the keychain's Codex login reaches the session when it has time left", async () => {
  const scripted = sessions();
  const keychain = fakeKeychain(join(base, `keychain-${++made}`));
  const access = codexJwt('acct');
  keychain.hold({ access, refresh: 'refresh-1', expires: Date.now() + 3_600_000, accountId: 'acct' });
  const harness = createPiHarness({ env: keychain.env, ...scripted });
  const result = await harness.run(request('done', { model: 'openai-codex/gpt-5.5' }));
  expect({ result: summary(result), key: scripted.calls[0]?.params.apiKey === access }).toEqual({
    result: SPEC,
    key: true,
  });
});

// A run's events folded into the run view's model (D6, D7): one stage card per call in the order calls start, pending
// cards for the roster stages not called yet, loop iterations, routes, denials with their command, and a fold that
// counts what it can't read rather than throwing. The golden run and the recorded fixtures are the inputs.
import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { applyEvent, elapsedMs, emptyRun, foldRun } from '../../../src/dashboard/page/run-model';
import { readEvents } from '../../../src/events/consumers/ndjson';
import type { Summary } from '../../../src/events/summary';
import { DASHBOARD_FIXTURES, FAKE_2_ID, FAKE_3_ID, GOLDEN_RUN } from '../../helpers/dashboard';
import { FAKE_4_ID, REVIEW_KEYS } from '../../helpers/review-fixture';

const golden = () => readEvents(GOLDEN_RUN);
const fake2 = () => readEvents(join(DASHBOARD_FIXTURES, 'alpha', FAKE_2_ID));
const fake3 = () => readEvents(join(DASHBOARD_FIXTURES, 'beta', FAKE_3_ID));
const GOLDEN_KEYS = [
  'intake#1',
  'spec#1',
  'implement#1',
  'tests#1',
  'implement#2',
  'tests#2',
  'self-review#1',
  'publish#1',
];
const STAGE_NAMES = ['spec', 'implement', 'tests', 'self-review', 'describe', 'open', 'lint', 'intake', 'ticket'];

test("the golden run folds into eight settled cards with its summary's outcomes, durations and costs, its routes, its PR and no pending card", () => {
  const model = foldRun(golden());
  const summary = JSON.parse(readFileSync(join(GOLDEN_RUN, 'summary.json'), 'utf8')) as Summary;
  expect(model.cards.map((card) => card.key)).toEqual(GOLDEN_KEYS);
  expect(model.cards.map((card) => [card.key, card.state, card.outcome, card.durationMs])).toEqual(
    summary.calls.map((call) => [call.key, 'settled', call.outcome, call.durationMs]),
  );
  model.cards.forEach((card, i) => {
    const call = summary.calls[i];
    if (call?.costUsd === undefined) expect(card.costUsd).toBeUndefined();
    else expect(Math.abs((card.costUsd ?? Number.NaN) - call.costUsd)).toBeLessThan(1e-9);
  });
  expect(model.cards.map((card) => card.model)).toEqual([
    undefined,
    'claude-opus-5-5',
    'claude-sonnet-5',
    undefined,
    'claude-sonnet-5',
    undefined,
    'claude-opus-5-5',
    undefined,
  ]);
  expect(model.routes).toEqual(summary.routes as never);
  expect(model.pending).toEqual([]);
  expect([model.runId, model.workflow, model.end, model.pr]).toEqual([
    'FAKE-1-01M3BWNZM08Q4T6V2XRJ5KWD3N',
    'ticket-to-pr@1',
    { status: 'completed' },
    { number: 5, url: 'fake://codehost/fixture/pull/5' },
  ]);
  expect(model.ticket).toEqual({
    ticketKey: 'FAKE-1',
    title: 'Add a --shout flag to the greet command',
    url: 'fake://tickets/FAKE-1',
  });
  expect([model.unreadable, model.loops]).toEqual([0, { fix: { iteration: 2, max: 3, exited: 'break' } }]);
});

test("the golden run's run-level events, run:keep_awake among them, count no type the fold doesn't handle (review R4)", () => {
  const events = golden();
  expect(events.some((event) => event.type === 'run:keep_awake')).toBe(true);
  expect(foldRun(events).other).toEqual({});
});

test("each card records the loop iteration open when its call started: fix 1 of 3 for implement#1 and tests#1, and 2 for the second pass's three", () => {
  const iterations = foldRun(golden()).cards.map((card) =>
    card.iteration === undefined ? '-' : `${card.iteration.loop} ${card.iteration.iteration}/${card.iteration.max}`,
  );
  expect(iterations).toEqual(['-', '-', 'fix 1/3', 'fix 1/3', 'fix 2/3', 'fix 2/3', 'fix 2/3', '-']);
});

test('folded event by event, tests#1 runs from its stage:start with no card after it, and settles failed at its stage:end', () => {
  const events = golden();
  const model = emptyRun();
  const start = events.findIndex((event) => event.type === 'stage:start' && event.key === 'tests#1');
  const end = events.findIndex((event) => event.type === 'stage:end' && event.key === 'tests#1');
  for (const event of events.slice(0, start + 1)) applyEvent(model, event);
  const card = model.cards.at(-1);
  expect([card?.key, card?.state, card?.outcome, card?.kind, model.cards.length]).toEqual([
    'tests#1',
    'running',
    undefined,
    'script',
    4,
  ]);
  const startedAt = Date.parse(events[start]?.ts ?? '');
  expect(card && elapsedMs(card, startedAt + 2500)).toBe(2500);
  expect(model.pending.map((pending) => pending.stage)).toEqual(['publish', 'self-review']);
  for (const event of events.slice(start + 1, end + 1)) applyEvent(model, event);
  expect([card?.state, card?.outcome, card?.durationMs, card && elapsedMs(card, startedAt + 99_999)]).toEqual([
    'settled',
    'failed',
    700,
    700,
  ]);
  expect(card?.files.map((file) => [file.name, file.bytes])).toEqual([['junit.xml', 893]]);
  expect(model.cards.length).toBe(4);
  expect(model.lastSeq).toBe(events[end]?.seq ?? -1);
});

test("FAKE-2's implement#1 has one denial, of Bash's git push --force origin HEAD under the step's commands, and ended in error from the harness", () => {
  const events = fake2();
  const model = foldRun(events);
  const card = model.cards.find((entry) => entry.key === 'implement#1');
  const commands = model.roster?.stages.implement?.permissions?.commands;
  const denied = events.find((event) => event.type === 'permission:denied');
  expect(card?.denials).toEqual([
    {
      seq: denied?.seq ?? 0,
      ts: '2026-09-23T10:00:04.730Z',
      callId: 'toolu-1',
      tool: 'Bash',
      rule: 'commands',
      permissions: { commands: commands as string[] },
      reason:
        'default deny: git push --force — a forced push rewrites what others have: `git push --force origin HEAD`',
      command: 'git push --force origin HEAD',
    },
  ]);
  expect(commands).toEqual(['bun test*', 'git add *', 'git commit *', 'git diff *']);
  expect([card?.outcome, card?.errors, card?.toolCalls, card?.turns]).toEqual([
    'error',
    [{ reason: 'harness', message: 'the session ended before it submitted a result' }],
    1,
    1,
  ]);
  expect(model.end).toEqual({
    status: 'failed',
    stopReason: 'stage_error',
    message: 'implement#1 ended in error: harness: the session ended before it submitted a result',
  });
});

test("FAKE-3 has a lint#1 card, the stages never called pending in the roster's order, ends suspended, and counts its run budget's budget:exceeded on the run", () => {
  const model = foldRun(fake3());
  expect(model.cards.map((card) => [card.key, card.kind, card.outcome])).toEqual([
    ['intake#1', 'builtin', 'passed'],
    ['spec#1', 'agent', 'done'],
    ['lint#1', 'script', 'passed'],
    ['implement#1', 'agent', 'error'],
  ]);
  expect(model.pending).toEqual([
    { stage: 'describe', kind: 'agent', model: 'claude-sonnet-5' },
    { stage: 'open', kind: 'script' },
    { stage: 'self-review', kind: 'agent', model: 'claude-opus-5-5' },
    { stage: 'tests', kind: 'script' },
  ]);
  expect(model.end).toMatchObject({ status: 'suspended', stopReason: 'budget_exceeded' });
  expect(model.other).toEqual({ 'budget:exceeded': 1 });
  expect(model.ticket?.title).toBe('Escape <b>this</b> & "that"');
});

test('a roster stage the page has never seen shows as a pending card, and run-model.ts names no stage', () => {
  const [start] = golden();
  const roster = {
    intake: { name: 'ticket', origin: 'builtin' },
    stages: { 'zz-new': { kind: 'agent', origin: 'repo:x', model: 'm-1' } },
  };
  const model = foldRun([{ ...start, roster }]);
  expect(model.pending).toEqual([{ stage: 'zz-new', kind: 'agent', model: 'm-1' }]);
  const source = readFileSync(
    join(import.meta.dir, '..', '..', '..', 'src', 'dashboard', 'page', 'run-model.ts'),
    'utf8',
  );
  const named = STAGE_NAMES.filter((name) => new RegExp(`['"\`]${name}(['"\`#/])`).test(source));
  expect(named).toEqual([]);
});

test("a corrective try reuses its call's card, whose tries is the highest try, and a step adds itself to its call", () => {
  const events = golden();
  const start = events.find((event) => event.type === 'stage:start' && event.key === 'spec#1');
  const tests = events.find((event) => event.type === 'stage:start' && event.key === 'tests#1');
  const at = { seq: 900, ts: '2026-09-25T09:00:30.000Z', runId: 'x' };
  const model = foldRun([
    events[0],
    start,
    { ...start, try: 2 },
    tests,
    { ...at, type: 'step:start', key: 'tests#1/lint', stage: 'tests', step: 'lint', index: 1, of: 2, kind: 'script' },
    { ...at, type: 'step:end', key: 'tests#1/lint', step: 'lint', outcome: 'passed', resultPath: 'x/result.json' },
  ]);
  expect(model.cards.map((card) => [card.key, card.tries])).toEqual([
    ['spec#1', 2],
    ['tests#1', 1],
  ]);
  expect(model.cards[1]?.steps).toEqual([{ step: 'lint', index: 1, of: 2, kind: 'script', outcome: 'passed' }]);
});

test('a card and a pending card carry the named harness from the stage:start or the roster, and a call on the default carries none', () => {
  const events = golden();
  const start = events.find((event) => event.type === 'stage:start' && event.key === 'spec#1');
  const named = foldRun([events[0], { ...start, harness: 'second' }]);
  expect(named.cards.map((card) => [card.key, card.harness])).toEqual([['spec#1', 'second']]);
  const plain = foldRun([events[0], start]);
  expect(plain.cards.map((card) => card.harness)).toEqual([undefined]);

  const roster = events[0] as { roster: { stages: Record<string, { harness?: string }> } };
  const stages = {
    ...roster.roster.stages,
    'self-review': { ...roster.roster.stages['self-review'], harness: 'second' },
  };
  const pending = foldRun([{ ...events[0], roster: { ...roster.roster, stages } }, start]).pending;
  expect(pending.find((card) => card.stage === 'self-review')?.harness).toBe('second');
  expect(pending.find((card) => card.stage === 'implement')?.harness).toBeUndefined();
});

test("live cost: a session's usage updates, then a second session's, sum to what each last said before any session end", () => {
  const events = golden();
  const at = { ts: '2026-09-25T09:00:30.000Z', runId: 'x', key: 'spec#1' };
  const usage = (seq: number, costUsdSoFar: number) => ({
    ...at,
    seq,
    type: 'usage:update',
    turn: 1,
    tokens: {},
    costUsdSoFar,
  });
  const session = (seq: number, sessionId: string) => ({
    ...at,
    seq,
    type: 'harness:session_start',
    adapter: 'fake',
    sessionId,
    model: 'm',
  });
  const model = foldRun([
    events[0],
    events.find((event) => event.type === 'stage:start' && event.key === 'spec#1'),
    session(901, 'a'),
    usage(902, 0.1),
    usage(903, 0.25),
    session(904, 'b'),
    usage(905, 0.05),
  ]);
  expect(model.cards.map((card) => card.key)).toEqual(['spec#1']);
  expect(model.cards[0]?.costUsd).toBeCloseTo(0.3, 9);
  expect(model.cards[0]?.state).toBe('running');
});

test("live tokens: a session's last usage update counts until its end, whose usage replaces it, and a later session's adds to it", () => {
  const events = golden();
  const at = { ts: '2026-09-25T09:00:30.000Z', runId: 'x', key: 'spec#1' };
  const usage = (seq: number, input: number, output: number, cacheRead: number) => ({
    ...at,
    seq,
    type: 'usage:update',
    turn: 1,
    tokens: { input, output, cacheRead, cacheWrite: 0 },
    costUsdSoFar: 0.01,
  });
  const start = events.find((event) => event.type === 'stage:start' && event.key === 'spec#1');
  const end = {
    ...at,
    seq: 904,
    type: 'harness:session_end',
    outcome: 'completed',
    turns: 2,
    toolCalls: 0,
    denials: 0,
    usage: { inputTokens: 1200, outputTokens: 300, cacheReadTokens: 9000, costUsd: 0.02 },
  };
  const before = [events[0], start, usage(901, 100, 10, 1000), usage(902, 500, 50, 4000)];
  expect(foldRun(before).cards[0]?.tokens).toEqual({ input: 500, output: 50, cacheRead: 4000 });
  expect(foldRun([...before, end]).cards[0]?.tokens).toEqual({ input: 1200, output: 300, cacheRead: 9000 });
  expect(foldRun([...before, end, usage(905, 7, 3, 20)]).cards[0]?.tokens).toEqual({
    input: 1207,
    output: 303,
    cacheRead: 9020,
  });
});

test("a file's validation joins its card's file, and a denied tool call with no command shows its input as JSON", () => {
  const events = golden();
  const at = { seq: 900, ts: '2026-09-25T09:00:30.000Z', runId: 'x', key: 'spec#1' };
  const model = foldRun([
    events[0],
    events.find((event) => event.type === 'stage:start' && event.key === 'spec#1'),
    { ...at, type: 'file:produced', name: 'spec.md', path: '01-spec/call-1/spec.md', bytes: 427, sha256: 'ab' },
    { ...at, type: 'file:validated', name: 'spec.md', ok: false, checks: ['has a title'] },
    { ...at, type: 'tool:start', callId: 't-1', tool: 'Write', input: { path: '/etc/passwd', text: 'x'.repeat(300) } },
    { ...at, type: 'tool:start', callId: 't-2', tool: 'Bash', input: { command: 'ls' } },
    {
      ...at,
      type: 'permission:denied',
      callId: 't-1',
      tool: 'Write',
      rule: 'write',
      permissions: { write: [] },
      reason: 'no',
    },
  ]);
  const [card] = model.cards;
  expect(card?.files).toEqual([
    { name: 'spec.md', path: '01-spec/call-1/spec.md', bytes: 427, sha256: 'ab', ok: false, checks: ['has a title'] },
  ]);
  const command = card?.denials[0]?.command ?? '';
  expect([command.length, command.startsWith('{"path":"/etc/passwd","text":"xxx'), command.endsWith('…')]).toEqual([
    201,
    true,
    true,
  ]);
});

/** A small deterministic generator, so a failing mutation can be found again. */
function random(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1_103_515_245 + 12_345) % 2 ** 31;
    return state / 2 ** 31;
  };
}

test('an unknown type counts on its card, an event that does not fit counts as unreadable and changes no card, and 200 random mutations never throw', () => {
  const events = golden();
  const at = { ts: '2026-09-25T09:00:30.000Z', runId: 'x' };
  const model = foldRun([
    ...events.slice(0, 14),
    { ...at, seq: 901, type: 'budget:warning', key: 'spec#1' },
    { ...at, seq: 902, type: 'stage:end', key: 'nope#1', stage: 'nope', outcome: 'done', durationMs: 1 },
    { ...at, seq: 903, type: 'stage:start', key: 7, stage: 'spec', call: 2, try: 1, kind: 'agent' },
    { ...at, seq: 904, type: 'stage:start', key: 'spec#2', stage: 'spec', call: '2', try: 1, kind: 'agent' },
    null,
    'not an event',
    { seq: 905 },
  ]);
  expect(model.cards.map((card) => card.key)).toEqual(['intake#1', 'spec#1']);
  expect(model.cards[1]?.other).toEqual({ 'budget:warning': 1 });
  expect(model.unreadable).toBe(6);

  const next = random(42);
  const values = [null, undefined, 7, -1, '', 'x', '<b>', [], {}, { key: 'spec#1' }, true, Number.NaN];
  for (let round = 0; round < 200; round++) {
    const mutated = structuredClone(events) as unknown as Record<string, unknown>[];
    const target = mutated[Math.floor(next() * mutated.length)] as Record<string, unknown>;
    const fields = Object.keys(target);
    const field = fields[Math.floor(next() * fields.length)] ?? 'type';
    target[field] = values[Math.floor(next() * values.length)];
    expect(() => foldRun(mutated)).not.toThrow();
  }
});

test('event types, loop names and tool call ids that are Object.prototype keys are counted and kept as their own, and a denial names only its own command (review R1-5)', () => {
  const at = { ts: '2026-09-25T09:00:30.000Z', runId: 'x', key: 'spec#1' };
  const model = foldRun([
    ...golden().slice(0, 14),
    { ...at, seq: 901, type: 'constructor' },
    { ...at, seq: 902, type: 'toString' },
    { ...at, seq: 903, type: 'loop:iteration', loop: '__proto__', iteration: 1, max: 2 },
    { ...at, seq: 904, type: 'tool:start', callId: '__proto__', tool: 'Bash', input: { c3: { command: 'git push' } } },
    { ...at, seq: 905, type: 'permission:denied', callId: 'c3', tool: 'Bash', rule: 'commands', permissions: {} },
  ]);
  const card = model.cards.find((entry) => entry.key === 'spec#1');
  expect(Object.entries(card?.other ?? {})).toEqual([
    ['constructor', 1],
    ['toString', 1],
  ]);
  expect(Object.entries(model.loops)).toEqual([['__proto__', { iteration: 1, max: 2 }]]);
  expect(card?.denials.map((denial) => [denial.callId, denial.command])).toEqual([['c3', undefined]]);
  expect(model.unreadable).toBe(0);
});

test("a group's all:start lists it once, though a resume reports it again, its all:end ends it, each call started while it is open carries its index, and neither counts as a type the fold doesn't handle", () => {
  const events = readEvents(join(DASHBOARD_FIXTURES, 'beta', FAKE_4_ID));
  const started = events.find((event) => event.type === 'all:start');
  const ended = events.findIndex((event) => event.type === 'all:end');
  const open = foldRun(events.slice(0, ended));
  expect(open.groups).toEqual([{ keys: REVIEW_KEYS, ended: false }]);
  const again = { ...started, seq: 999, running: ['coverage#1'] };
  const model = foldRun([...events.slice(0, ended), again, ...events.slice(ended)]);
  expect(model.groups).toEqual([{ keys: REVIEW_KEYS, ended: true }]);
  expect(model.cards.map((card) => [card.key, card.group])).toEqual([
    ['intake#1', undefined],
    ...REVIEW_KEYS.map((key) => [key, 0]),
  ]);
  expect(
    [model.other, ...model.cards.map((card) => card.other)].filter((other) => Object.keys(other).length > 0),
  ).toEqual([]);
});

test('an intake:start naming a harness gives the intake card that harness, and one naming none gives it none', () => {
  const at = { ts: '2026-09-25T09:00:30.000Z', runId: 'x', seq: 1 };
  const intake = { ...at, type: 'intake:start', key: 'intake#1', intake: 'groom', kind: 'agent' };
  const named = emptyRun();
  applyEvent(named, { ...intake, harness: 'second' });
  const plain = emptyRun();
  applyEvent(plain, intake);
  expect([named.cards[0]?.harness, plain.cards[0]?.harness]).toEqual(['second', undefined]);
});

test("an intake:start of kind stage is the run's intake card, with the steps that start under its key", () => {
  const at = { ts: '2026-09-25T09:00:30.000Z', runId: 'x' };
  const model = emptyRun();
  const events = [
    { ...at, seq: 1, type: 'intake:start', key: 'intake#1', intake: 'groom', kind: 'stage', steps: ['fetch', 'shape'] },
    {
      ...at,
      seq: 2,
      type: 'step:start',
      key: 'intake#1/fetch',
      stage: 'intake',
      step: 'fetch',
      index: 1,
      of: 2,
      kind: 'script',
    },
    { ...at, seq: 3, type: 'step:end', key: 'intake#1/fetch', stage: 'intake', step: 'fetch', outcome: 'passed' },
    { ...at, seq: 4, type: 'intake:end', key: 'intake#1', outcome: 'done' },
  ];
  for (const event of events) applyEvent(model, event);
  const [card] = model.cards;
  expect([model.intakeKey, model.cards.length, model.unreadable]).toEqual(['intake#1', 1, 0]);
  expect([card?.key, card?.stage, card?.kind, card?.outcome]).toEqual(['intake#1', 'groom', 'stage', 'done']);
  expect(card?.steps).toEqual([{ step: 'fetch', index: 1, of: 2, kind: 'script', outcome: 'passed' }]);
});

test("a card's timeline holds its messages, steps and script commands with their exits, in order: the golden run's", () => {
  const model = foldRun(golden());
  const timeline = (key: string) => model.cards.find((card) => card.key === key)?.timeline;
  expect(timeline('intake#1')).toEqual([]);
  expect(timeline('spec#1')).toEqual([
    {
      kind: 'message',
      ts: '2026-09-25T09:00:03.000Z',
      text: 'Spec written: two tasks, greet() and the CLI first, then the tests.',
    },
  ]);
  expect(timeline('tests#1')).toEqual([
    {
      kind: 'script',
      ts: '2026-09-25T09:00:06.600Z',
      command: '.sail/stages/tests/run.sh',
      durationMs: 100,
      code: 1,
      outcome: 'failed',
    },
  ]);
  expect(timeline('publish#1')?.map((entry) => (entry.kind === 'step' ? `step ${entry.step}` : entry.kind))).toEqual([
    'step describe',
    'message',
    'step open',
    'script',
  ]);
});

test("a tool call is one timeline entry: started running, given its denial, and ended with its status, duration and result; an id another card used is that card's own (ADW-260)", () => {
  const at = { ts: '2026-09-25T09:00:30.000Z', runId: 'x' };
  const spec = { ...at, key: 'spec#1' };
  const implement = { ...at, key: 'implement#1' };
  const denied = { type: 'permission:denied', callId: 'c1', permissions: {} };
  const model = foldRun([
    ...golden().slice(0, 14),
    { ...spec, seq: 901, type: 'agent:thinking', text: '' },
    { ...spec, seq: 902, type: 'agent:thinking', text: 'Read the brief first.' },
    { ...spec, seq: 903, type: 'tool:start', callId: 'c1', tool: 'Bash', input: { command: 'git push' } },
    // A call running beside spec#1 starts a tool with the same id before spec#1's is denied.
    { ...implement, seq: 904, type: 'stage:start', stage: 'implement', call: 1, try: 1, kind: 'agent' },
    { ...implement, seq: 905, type: 'tool:start', callId: 'c1', tool: 'Read', input: { file_path: 'a.ts' } },
    { ...spec, ...denied, seq: 906, tool: 'Bash', rule: 'commands', reason: 'no' },
    { ...spec, seq: 907, type: 'tool:end', callId: 'c1', status: 'denied', durationMs: 3, result: 'refused' },
    { ...spec, seq: 908, type: 'tool:end', callId: 'never-started', status: 'completed', durationMs: 1 },
    { ...spec, seq: 909, type: 'tool:end', callId: 'c1', status: 'exploded', durationMs: 1 },
    { ...implement, ...denied, seq: 910, tool: 'Read', rule: 'read', reason: 'out' },
  ]);
  const [, spec1, implement1] = model.cards;
  expect(spec1?.timeline).toEqual([
    { kind: 'thinking', ts: at.ts, text: 'Read the brief first.' },
    {
      kind: 'tool',
      ts: at.ts,
      callId: 'c1',
      tool: 'Bash',
      input: { command: 'git push' },
      status: 'denied',
      durationMs: 3,
      result: 'refused',
      denial: { rule: 'commands', reason: 'no' },
    },
  ]);
  expect(implement1?.timeline).toEqual([
    {
      kind: 'tool',
      ts: at.ts,
      callId: 'c1',
      tool: 'Read',
      input: { file_path: 'a.ts' },
      status: 'running',
      denial: { rule: 'read', reason: 'out' },
    },
  ]);
  expect([spec1?.denials[0]?.command, implement1?.denials[0]?.command]).toEqual(['git push', '{"file_path":"a.ts"}']);
  expect(model.unreadable).toBe(1);
});

test("a queued step joins its call's timeline, and one without a holder is unreadable", () => {
  const at = { ts: '2026-09-25T09:00:30.000Z', runId: 'x', key: 'spec#1' };
  const holder = { runId: 'HOLDER-1', key: 'verify#1', pid: 4242, takenAt: '2026-09-25T09:00:00.000Z' };
  const model = foldRun([
    ...golden().slice(0, 14),
    { ...at, seq: 901, type: 'step:queued', exclusive: 'verify', holder },
    { ...at, seq: 902, type: 'script:exec', command: 'make', cwd: '.', envKeys: [] },
    { ...at, seq: 903, type: 'step:queued', exclusive: 'verify' },
  ]);
  expect(model.cards[1]?.timeline.slice(-2)).toEqual([
    { kind: 'queued', ts: at.ts, exclusive: 'verify', holder: 'HOLDER-1' },
    { kind: 'script', ts: at.ts, command: 'make' },
  ]);
  expect(model.unreadable).toBe(1);
});

test('a later try is a timeline entry, and a script exit ends the open script with its code or signal, passes over one with none open, and is unreadable without a duration', () => {
  const at = { ts: '2026-09-25T09:00:30.000Z', runId: 'x', key: 'spec#1' };
  const model = foldRun([
    ...golden().slice(0, 14),
    { ...at, seq: 901, type: 'script:exit', code: 0, durationMs: 1, stdoutBytes: 0 },
    { ...at, seq: 902, type: 'stage:start', stage: 'spec', call: 1, try: 2, kind: 'agent' },
    { ...at, seq: 903, type: 'script:exec', command: 'sleep 9', cwd: '.', envKeys: [] },
    { ...at, seq: 904, type: 'script:exit', code: 1, stdoutBytes: 0 },
    { ...at, seq: 905, type: 'script:exit', code: null, signal: 'SIGTERM', durationMs: 9000, stdoutBytes: 0 },
    { ...at, seq: 906, type: 'script:exec', cwd: '.', envKeys: [] },
  ]);
  expect(model.cards[1]?.timeline).toEqual([
    { kind: 'try', ts: at.ts, try: 2 },
    { kind: 'script', ts: at.ts, command: 'sleep 9', durationMs: 9000, signal: 'SIGTERM' },
  ]);
  expect(model.unreadable).toBe(2);
});

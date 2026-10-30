// A run's summary: its events folded into `sail.summary.v1`. The summary is derived from the events and never read for
// resume (ADR-0002), so a rebuild from `events.ndjson` gives the same document. Ported from the prototype's summary
// consumer, which kept a rolling summary of the stream.
//
// A resume writes no marker, so the fold infers the run's status from its last `run:end`, keeps each call's latest
// try, takes each loop's highest iteration, and drops a route the resume reported again.
//
// A seeded run's reused calls arrive as `journal:append` events carrying `fromRun`. Each is listed among the calls, in
// event order, with that `fromRun` and no duration, and counts in no total: the totals are this run's own work. A
// reused step's line is its call's, and lists nothing of its own.
//
// A multi-step call a resume starts again keeps the steps it ended before: they are journaled and don't run again, so
// their facts would otherwise be lost with the earlier process's `stage:start`.
//
// A step's duration is its `step:end`'s, the base its call's sums; one written before `step:end` carried it is timed
// from its `step:start` to its `step:end`.
//
// A group's calls are listed among the calls like any other, in `stage:start` order, and the group itself in `groups`:
// its keys in declaration order from its `all:start`, and its duration once its `all:end` came. A resume that runs the
// rest of a group reports its `all:start` again, and the group is listed once.
//
// The run's ticket is the one its intake fetched: the first `ticket:fetched` under the intake's key. A script step's
// `sail port ticket-source get` emits one too, under its own key, and names another fetch, not the run's ticket.
// A seeded run fetches nothing: its reused intake's `journal:append` carries the ticket instead, and names it the
// same way.
//
// A script step's `sail port jev ask` emits a `jev:asked` under its key. Each one is summed into its call, its step when
// the key holds one, and the run's totals; one with no key counts in the totals alone. A call that starts again starts
// its count over, as it does its other facts, from the steps it keeps. A run that asked Jev nothing has no `jev`
// anywhere.
// Stalled steps are listed only until their next keyed event, or the run ends or suspends.
import { INTAKE_KEY } from '../engine/intake';
import type { JournalEntry } from '../engine/journal';
import type { StopReason } from '../engine/run-dir';
import type { SailEvent } from './types';

type Outcome = JournalEntry['outcome'];

/** What the Jev calls of a call, a step or a run came to: how many, the questions asked, the time they took, and usage. */
export interface JevTotals {
  calls: number;
  questions: number;
  latencyMs: number;
  inputTokens?: number;
  outputTokens?: number;
}

/** One step of a multi-step call. */
export interface StepEntry {
  key: string;
  kind: 'agent' | 'script';
  /** The named harness the step ran on. Left out for the default harness. */
  harness?: string;
  outcome: Outcome;
  durationMs: number;
  turns?: number;
  toolCalls?: number;
  costUsd?: number;
  jev?: JevTotals;
  files?: string[];
  summary?: string;
}

/**
 * One call, the intake or a stage's, at its latest try. A multi-step call has no kind: its steps do. Only a built-in
 * intake's call is `builtin`.
 */
export interface CallEntry {
  key: string;
  kind?: 'agent' | 'script' | 'builtin';
  /** The named harness the call ran on. Left out for the default harness. */
  harness?: string;
  outcome: Outcome;
  durationMs: number;
  turns?: number;
  toolCalls?: number;
  denials?: number;
  costUsd?: number;
  commits?: number;
  jev?: JevTotals;
  feedbackFrom?: string;
  files?: string[];
  summary?: string;
  resultPath?: string;
  steps?: StepEntry[];
  /** The run a reused call was taken from. */
  fromRun?: string;
}

/** One group: its keys in declaration order, and how long it took once it ended. */
export interface GroupEntry {
  keys: string[];
  durationMs?: number;
}

/** Tokens and dollars. */
export interface Usage {
  inputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  outputTokens?: number;
  costUsd: number;
}

/** `summary.json`, as `sail.summary.v1` shapes it. */
export interface Summary {
  schema: 'sail.summary.v1';
  runId: string;
  workflow: string;
  source:
    | { kind: 'ticket'; ticketKey: string; via: 'cli' | 'watch' }
    | { kind: 'pr'; number: number; headSha: string; via: 'cli' | 'watch' };
  ticket?: { ticketKey: string; title: string; url?: string };
  status: 'running' | 'suspended' | 'completed' | 'failed';
  stopReason?: StopReason;
  /** Why the run stopped, as its `run:end` said it. */
  message?: string;
  startedAt: string;
  endedAt?: string;
  durationMs?: number;
  result?: unknown;
  calls: CallEntry[];
  stalled?: { key: string; since: string }[];
  loops?: Record<string, { iterations: number; max: number }>;
  routes?: { at: string; value: unknown; took: string }[];
  /** The calls that ran together, each group's keys in declaration order: present only when the run had a group. */
  groups?: GroupEntry[];
  totals: {
    stageCalls: number;
    steps: number;
    toolCalls: number;
    denials: number;
    replays: number;
    usage: Usage;
    jev?: JevTotals;
    budget?: { maxUsd: number; usedPct: number };
  };
  version: number;
}

type EventOf<T extends SailEvent['type']> = Extract<SailEvent, { type: T }>;

const TOKENS = ['inputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'outputTokens'] as const;

/** What an agent session reported about itself, each fact only when it is a valid number. */
interface Facts {
  turns?: number | undefined;
  toolCalls?: number | undefined;
  denials?: number | undefined;
  costUsd?: number | undefined;
}

interface Ended {
  outcome: Outcome;
  durationMs: number;
}

interface StepState {
  key: string;
  kind: 'agent' | 'script';
  harness?: string;
  startedAt: string;
  end?: Ended;
  facts: Facts;
  files: string[];
  jev?: JevTotals;
}

/** A call at its latest try: a new try starts it over, in the same place. */
interface CallState {
  key: string;
  kind: 'agent' | 'script' | 'stage' | 'builtin';
  harness?: string;
  startedAt: string;
  end?: Ended & { resultPath?: string };
  /** The run a reused call was taken from: it ran there, not in this run. */
  fromRun?: string;
  facts: Facts;
  /** The latest loop feedback pointer, when this try consumed it. */
  feedback?: string;
  files: string[];
  steps: Map<string, StepState>;
  jev?: JevTotals;
}

/** The fold so far. Opaque: start it with emptyState(), feed it with foldEvent() and read it with toSummary(). */
export interface SummaryState {
  run?: { runId: string; workflow: string; source: Summary['source']; startedAt: string; maxUsd?: number | undefined };
  /** The ticket the intake fetched. */
  ticket?: NonNullable<Summary['ticket']>;
  ending?:
    | {
        status: 'completed' | 'failed' | 'suspended';
        stopReason?: StopReason;
        message?: string;
        endedAt: string;
        result?: unknown;
      }
    | undefined;
  latestTs?: string;
  calls: Map<string, CallState>;
  stalled: Map<string, string>;
  /** Each ended call's and step's `resultPath`, to the key it belongs to. */
  results: Map<string, string>;
  /** Each running loop's latest feedback pointer, by loop name. */
  feedback: Map<string, string>;
  loops: Map<string, { iterations: number; max: number }>;
  routes: { at: string; value: unknown; took: string }[];
  /** Each group, in the order its first `all:start` came. */
  groups: GroupEntry[];
  journaledSinceRoute: boolean;
  totals: {
    toolCalls: number;
    denials: number;
    replays: number;
    tokens: Partial<Record<(typeof TOKENS)[number], number>>;
    costUsd: number;
    jev?: JevTotals;
  };
}

/** A whole number of 0 or more, or undefined: an open payload's count, read defensively. */
const count = (value: unknown): number | undefined =>
  Number.isInteger(value) && (value as number) >= 0 ? (value as number) : undefined;

/** Dollars of 0 or more, or undefined. */
const dollars = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;

/** Summed dollars without the float noise, to 6 decimals. */
const round = (usd: number): number => Math.round(usd * 1e6) / 1e6;

const elapsed = (from: string, to: string): number => Math.max(0, Date.parse(to) - Date.parse(from));

/** The call a key belongs to: `publish#1` for `publish#1/open`. */
const callKeyOf = (key: string): string => key.split('/')[0] ?? key;

/** `fields` without the undefined ones, in their own order: a summary leaves out what it doesn't know. */
function defined<T extends object>(fields: { [K in keyof T]: T[K] | undefined }): T {
  return Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined)) as T;
}

/** A fold that has seen no event yet. */
export function emptyState(): SummaryState {
  return {
    calls: new Map(),
    stalled: new Map(),
    results: new Map(),
    feedback: new Map(),
    loops: new Map(),
    routes: [],
    groups: [],
    journaledSinceRoute: false,
    totals: { toolCalls: 0, denials: 0, replays: 0, tokens: {}, costUsd: 0 },
  };
}

/** Folds one event into `state`. */
export function foldEvent(state: SummaryState, event: SailEvent): void {
  state.latestTs = event.ts;
  if (event.type === 'step:stalled') state.stalled.set(event.key, event.since);
  else if ('key' in event && event.key !== undefined) state.stalled.delete(event.key);
  if (event.type === 'run:end' || event.type === 'run:suspended') state.stalled.clear();
  // A resume writes no marker: whatever follows a run:end means the run is going again. A consumer that failed on
  // run:end reports after it, and changes nothing.
  if (event.type !== 'run:end' && event.type !== 'error:consumer') state.ending = undefined;
  switch (event.type) {
    case 'run:start':
      foldRunStart(state, event);
      break;
    case 'run:end':
      foldRunEnd(state, event);
      break;
    case 'intake:start':
    case 'stage:start':
      startCall(state, event);
      break;
    case 'intake:end':
    case 'stage:end':
      endCall(state, event);
      break;
    case 'step:start':
      startStep(state, event);
      break;
    case 'step:end':
      endStep(state, event);
      break;
    case 'file:produced':
      foldFile(state, event);
      break;
    case 'harness:session_end':
      foldSession(state, event);
      break;
    case 'jev:asked':
      foldJev(state, event);
      break;
    case 'ticket:fetched':
      if (event.key === INTAKE_KEY) state.ticket ??= { ticketKey: event.ticketKey, title: event.title, url: event.url };
      break;
    case 'loop:iteration':
      holdFeedback(state, event.loop, event.feedback?.from);
      raiseLoop(state, event.loop, event.iteration, event.max);
      break;
    case 'loop:exit':
      state.feedback.delete(event.loop);
      raiseLoop(state, event.loop, event.iterations, event.max);
      break;
    case 'workflow:route':
      foldRoute(state, event);
      break;
    case 'all:start':
      if (groupOf(state, event.keys) === undefined) state.groups.push({ keys: [...event.keys] });
      break;
    case 'all:end': {
      const group = groupOf(state, event.keys);
      if (group !== undefined) group.durationMs = event.durationMs;
      break;
    }
    case 'journal:append':
      // A step's line is its call's: the replay makes no move after it, so a route the resume reports again repeats.
      if (!event.key.includes('/')) state.journaledSinceRoute = true;
      if (event.fromRun !== undefined) reuseCall(state, event, event.fromRun);
      if (event.key === INTAKE_KEY && event.ticket !== undefined) state.ticket ??= { ...event.ticket };
      break;
    case 'budget:raised':
      // The budget is the raised one from here on: `totals.budget` follows it.
      if (state.run !== undefined && event.budget.maxUsd !== undefined) state.run.maxUsd = event.budget.maxUsd;
  }
}

function foldRunStart(state: SummaryState, event: EventOf<'run:start'>): void {
  if (state.run !== undefined) return;
  const { source } = event;
  state.run = {
    runId: event.runId,
    workflow: `${event.workflow.name}@${event.workflow.version}`,
    source:
      source.kind === 'ticket'
        ? { kind: 'ticket', ticketKey: source.ticketKey, via: source.via }
        : { kind: 'pr', number: source.number, headSha: source.headSha, via: source.via },
    startedAt: event.ts,
    maxUsd: event.budget?.maxUsd,
  };
}

function foldRunEnd(state: SummaryState, event: EventOf<'run:end'>): void {
  state.ending = defined<NonNullable<SummaryState['ending']>>({
    status: event.status,
    stopReason: event.stopReason,
    message: event.message,
    endedAt: event.ts,
    result: event.status === 'completed' ? event.result : undefined,
  });
  state.totals.replays += event.replays;
}

function startCall(state: SummaryState, event: EventOf<'intake:start'> | EventOf<'stage:start'>): void {
  const held = new Set(state.feedback.values());
  const feedback = Object.values(event.consumed).find((from): from is string => from !== null && held.has(from));
  const earlier = event.kind === 'stage' ? state.calls.get(event.key) : undefined;
  const kept = earlier === undefined ? [] : [...earlier.steps].filter(([, step]) => step.end !== undefined);
  const jev = kept.reduce<JevTotals | undefined>(
    (sum, [, step]) => (step.jev === undefined ? sum : sumJev(sum, step.jev)),
    undefined,
  );
  state.calls.set(event.key, {
    key: event.key,
    kind: event.kind,
    ...(event.harness === undefined ? {} : { harness: event.harness }),
    startedAt: event.ts,
    facts: {},
    ...(feedback === undefined ? {} : { feedback }),
    files: [...new Set(kept.flatMap(([, step]) => step.files))],
    steps: new Map(kept),
    ...(jev === undefined ? {} : { jev }),
  });
}

/**
 * `consumed` says `workflow` for any value no call produced. A feedback from there can't be told apart from a call's
 * other inputs, so it is never attributed: a call that took it shows no `feedbackFrom`.
 */
const UNTRACEABLE = 'workflow';

/** A loop's iteration holds its feedback pointer until the next iteration or the loop's exit. */
function holdFeedback(state: SummaryState, loop: string, from: string | undefined): void {
  if (from === undefined || from === UNTRACEABLE) state.feedback.delete(loop);
  else state.feedback.set(loop, from);
}

function endCall(state: SummaryState, event: EventOf<'intake:end'> | EventOf<'stage:end'>): void {
  const call = state.calls.get(event.key);
  if (call === undefined) return;
  const durationMs = event.type === 'stage:end' ? event.durationMs : elapsed(call.startedAt, event.ts);
  call.end = { outcome: event.outcome, durationMs, resultPath: event.resultPath };
  state.results.set(event.resultPath, event.key);
}

/** A reused call: listed as it ended in the run it came from, with no duration of this run's. */
function reuseCall(state: SummaryState, event: EventOf<'journal:append'>, fromRun: string): void {
  if (event.key.includes('/')) return;
  state.calls.set(event.key, {
    key: event.key,
    kind: 'builtin',
    startedAt: event.ts,
    end: { outcome: event.outcome, durationMs: 0 },
    fromRun,
    facts: {},
    files: [],
    steps: new Map(),
  });
}

function startStep(state: SummaryState, event: EventOf<'step:start'>): void {
  state.calls.get(callKeyOf(event.key))?.steps.set(event.key, {
    key: event.key,
    kind: event.kind,
    ...(event.harness === undefined ? {} : { harness: event.harness }),
    startedAt: event.ts,
    facts: {},
    files: [],
  });
}

function endStep(state: SummaryState, event: EventOf<'step:end'>): void {
  const step = state.calls.get(callKeyOf(event.key))?.steps.get(event.key);
  if (step === undefined) return;
  step.end = { outcome: event.outcome, durationMs: event.durationMs ?? elapsed(step.startedAt, event.ts) };
  state.results.set(event.resultPath, event.key);
}

function foldFile(state: SummaryState, event: EventOf<'file:produced'>): void {
  const call = state.calls.get(callKeyOf(event.key));
  if (call === undefined) return;
  for (const files of [call.files, call.steps.get(event.key)?.files]) {
    if (files !== undefined && !files.includes(event.name)) files.push(event.name);
  }
}

/** A session's facts go to its call or step, replacing an earlier session's, and every session counts in totals. */
function foldSession(state: SummaryState, event: EventOf<'harness:session_end'>): void {
  const usage = typeof event.usage === 'object' && event.usage !== null ? (event.usage as Record<string, unknown>) : {};
  const facts: Facts = {
    turns: count(event.turns),
    toolCalls: count(event.toolCalls),
    denials: count(event.denials),
    costUsd: dollars(usage.costUsd),
  };
  const { totals } = state;
  totals.toolCalls += facts.toolCalls ?? 0;
  totals.denials += facts.denials ?? 0;
  totals.costUsd += facts.costUsd ?? 0;
  for (const field of TOKENS) {
    const tokens = count(usage[field]);
    if (tokens !== undefined) totals.tokens[field] = (totals.tokens[field] ?? 0) + tokens;
  }
  if (event.key === undefined) return;
  const call = state.calls.get(callKeyOf(event.key));
  const owner = call?.key === event.key ? call : call?.steps.get(event.key);
  if (owner !== undefined) owner.facts = facts;
}

/** `into` with one Jev call added: usage is summed only once a call has reported it. */
function addJev(into: JevTotals | undefined, event: EventOf<'jev:asked'>): JevTotals {
  const one: JevTotals = { calls: 1, questions: event.questions, latencyMs: event.latencyMs };
  return sumJev(into, event.usage === undefined ? one : { ...one, ...event.usage });
}

/** `into`, which may be none, and `more` summed: usage is summed only once either has reported it. */
function sumJev(into: JevTotals | undefined, more: JevTotals): JevTotals {
  const next: JevTotals = {
    calls: (into?.calls ?? 0) + more.calls,
    questions: (into?.questions ?? 0) + more.questions,
    latencyMs: (into?.latencyMs ?? 0) + more.latencyMs,
  };
  if (into?.inputTokens !== undefined || more.inputTokens !== undefined) {
    next.inputTokens = (into?.inputTokens ?? 0) + (more.inputTokens ?? 0);
    next.outputTokens = (into?.outputTokens ?? 0) + (more.outputTokens ?? 0);
  }
  return next;
}

/** A Jev call counts in the run's totals, and in the call and step its key names. */
function foldJev(state: SummaryState, event: EventOf<'jev:asked'>): void {
  state.totals.jev = addJev(state.totals.jev, event);
  if (event.key === undefined) return;
  const call = state.calls.get(callKeyOf(event.key));
  if (call === undefined) return;
  call.jev = addJev(call.jev, event);
  const step = call.steps.get(event.key);
  if (step !== undefined) step.jev = addJev(step.jev, event);
}

/** Frontier events repeat after a resume, so a loop keeps the highest iteration any of them reported. */
function raiseLoop(state: SummaryState, name: string, iterations: number, max: number): void {
  state.loops.set(name, { iterations: Math.max(state.loops.get(name)?.iterations ?? 0, iterations), max });
}

/** The group listed with exactly these keys, in this order. */
const groupOf = (state: SummaryState, keys: readonly string[]): GroupEntry | undefined =>
  state.groups.find((group) => group.keys.length === keys.length && group.keys.every((key, i) => key === keys[i]));

/** The same move reported again with no call journaled since is a resume's repeat, and is dropped. */
function foldRoute(state: SummaryState, event: EventOf<'workflow:route'>): void {
  const last = state.routes.at(-1);
  const repeated =
    !state.journaledSinceRoute && last?.at === event.at && last.value === event.value && last.took === event.took;
  if (!repeated) state.routes.push({ at: event.at, value: event.value, took: event.took });
  state.journaledSinceRoute = false;
}

/** The summary `state` holds, or undefined before a `run:start`. */
export function toSummary(state: SummaryState): Summary | undefined {
  const { run, ending, totals } = state;
  if (run === undefined) return undefined;
  const ended = [...state.calls.values()].filter((call) => call.end !== undefined);
  const own = ended.filter((call) => call.fromRun === undefined);
  const costUsd = round(totals.costUsd);
  return defined<Summary>({
    schema: 'sail.summary.v1',
    runId: run.runId,
    workflow: run.workflow,
    source: { ...run.source },
    ticket: state.ticket === undefined ? undefined : { ...state.ticket },
    status: ending?.status ?? 'running',
    stopReason: ending?.stopReason,
    message: ending?.message,
    startedAt: run.startedAt,
    endedAt: ending?.endedAt,
    durationMs: elapsed(run.startedAt, ending?.endedAt ?? state.latestTs ?? run.startedAt),
    result: ending?.result,
    calls: ended.map((call) => callEntry(state, call)),
    stalled: state.stalled.size ? [...state.stalled].map(([key, since]) => ({ key, since })) : undefined,
    loops: Object.fromEntries([...state.loops].map(([name, loop]) => [name, { ...loop }])),
    routes: state.routes.map((route) => ({ ...route })),
    groups: state.groups.length === 0 ? undefined : state.groups.map((group) => ({ ...group, keys: [...group.keys] })),
    totals: defined<Summary['totals']>({
      stageCalls: own.length,
      steps: own.reduce((sum, call) => sum + (call.kind === 'stage' ? endedSteps(call).length : 1), 0),
      toolCalls: totals.toolCalls,
      denials: totals.denials,
      replays: totals.replays,
      usage: defined<Usage>({ ...totals.tokens, costUsd }),
      jev: totals.jev === undefined ? undefined : { ...totals.jev },
      budget:
        run.maxUsd === undefined
          ? undefined
          : { maxUsd: run.maxUsd, usedPct: run.maxUsd > 0 ? Math.round((costUsd / run.maxUsd) * 1000) / 10 : 0 },
    }),
    version: 1,
  });
}

/** The summary of `events`, or undefined when they hold no `run:start`. */
export function summarize(events: readonly SailEvent[]): Summary | undefined {
  const state = emptyState();
  for (const event of events) foldEvent(state, event);
  return toSummary(state);
}

const endedSteps = (call: CallState): (StepState & { end: Ended })[] =>
  [...call.steps.values()].filter((step): step is StepState & { end: Ended } => step.end !== undefined);

/** A multi-step call costs what its steps cost, and has no other agent facts: they belong to its steps. */
function stepsCost(call: CallState): number | undefined {
  const costs = [...call.steps.values()].flatMap((step) => step.facts.costUsd ?? []);
  return costs.length === 0 ? undefined : round(costs.reduce((sum, usd) => sum + usd, 0));
}

function callEntry(state: SummaryState, call: CallState): CallEntry {
  const end = call.end as NonNullable<CallState['end']>;
  if (call.fromRun !== undefined) {
    return { key: call.key, outcome: end.outcome, durationMs: end.durationMs, fromRun: call.fromRun };
  }
  const steps = endedSteps(call);
  const facts: Facts = call.kind === 'stage' ? { costUsd: stepsCost(call) } : call.facts;
  const pointer = call.feedback;
  return defined<CallEntry>({
    key: call.key,
    kind: call.kind === 'stage' ? undefined : call.kind,
    harness: call.harness,
    outcome: end.outcome,
    durationMs: end.durationMs,
    turns: facts.turns,
    toolCalls: facts.toolCalls,
    denials: facts.denials,
    costUsd: facts.costUsd,
    jev: call.jev === undefined ? undefined : { ...call.jev },
    // A pointer names a result and a place in it: the call is the one whose result it names.
    feedbackFrom: pointer === undefined ? undefined : (state.results.get(pointer.split('#')[0] ?? '') ?? pointer),
    files: call.files.length > 0 ? [...call.files] : undefined,
    resultPath: end.resultPath,
    steps: steps.length >= 2 ? steps.map(stepEntry) : undefined,
  });
}

function stepEntry(step: StepState & { end: Ended }): StepEntry {
  return defined<StepEntry>({
    key: step.key,
    kind: step.kind,
    harness: step.harness,
    outcome: step.end.outcome,
    durationMs: step.end.durationMs,
    turns: step.facts.turns,
    toolCalls: step.facts.toolCalls,
    costUsd: step.facts.costUsd,
    jev: step.jev === undefined ? undefined : { ...step.jev },
    files: step.files.length > 0 ? [...step.files] : undefined,
  });
}

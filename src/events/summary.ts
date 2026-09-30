// A run's summary: its events folded into `sail.summary.v1`. The summary is derived from the events and never read for
// resume (ADR-0002), so a rebuild from `events.ndjson` gives the same document. Ported from the prototype's summary
// consumer, which kept a rolling summary of the stream.
//
// A resume writes no marker, so the fold infers the run's status from its last `run:end`, keeps each call's latest
// try, takes each loop's highest iteration, and drops a route the resume reported again.
import type { JournalEntry } from '../engine/journal';
import type { StopReason } from '../engine/run-dir';
import type { SailEvent } from './types';

type Outcome = JournalEntry['outcome'];

/** One step of a multi-step call. */
export interface StepEntry {
  key: string;
  kind: 'agent' | 'script';
  outcome: Outcome;
  durationMs: number;
  turns?: number;
  toolCalls?: number;
  costUsd?: number;
  files?: string[];
  summary?: string;
}

/** One call, the intake or a stage's, at its latest try. A multi-step call has no kind: its steps do. */
export interface CallEntry {
  key: string;
  kind?: 'agent' | 'script';
  outcome: Outcome;
  durationMs: number;
  turns?: number;
  toolCalls?: number;
  denials?: number;
  costUsd?: number;
  commits?: number;
  feedbackFrom?: string;
  files?: string[];
  summary?: string;
  resultPath?: string;
  steps?: StepEntry[];
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
  source: { kind: 'ticket'; ticketKey: string; via: 'cli' | 'watch' };
  ticket?: { ticketKey: string; title: string; url?: string };
  status: 'running' | 'suspended' | 'completed' | 'failed';
  stopReason?: StopReason;
  startedAt: string;
  endedAt?: string;
  durationMs?: number;
  result?: unknown;
  calls: CallEntry[];
  loops?: Record<string, { iterations: number; max: number }>;
  routes?: { at: string; value: unknown; took: string }[];
  totals: {
    stageCalls: number;
    steps: number;
    toolCalls: number;
    denials: number;
    replays: number;
    usage: Usage;
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
  startedAt: string;
  end?: Ended;
  facts: Facts;
  files: string[];
}

/** A call at its latest try: a new try starts it over, in the same place. */
interface CallState {
  key: string;
  kind: 'agent' | 'script' | 'stage';
  startedAt: string;
  end?: Ended & { resultPath: string };
  facts: Facts;
  /** The latest loop feedback pointer, when this try consumed it. */
  feedback?: string;
  files: string[];
  steps: Map<string, StepState>;
}

/** The fold so far. Opaque: start it with emptyState(), feed it with foldEvent() and read it with toSummary(). */
export interface SummaryState {
  run?: { runId: string; workflow: string; source: Summary['source']; startedAt: string; maxUsd?: number | undefined };
  ending?:
    | { status: 'completed' | 'failed' | 'suspended'; stopReason?: StopReason; endedAt: string; result?: unknown }
    | undefined;
  latestTs?: string;
  calls: Map<string, CallState>;
  /** Each ended call's and step's `resultPath`, to the key it belongs to. */
  results: Map<string, string>;
  /** The latest `loop:iteration`'s feedback pointer. */
  feedback?: string | undefined;
  loops: Map<string, { iterations: number; max: number }>;
  routes: { at: string; value: unknown; took: string }[];
  journaledSinceRoute: boolean;
  totals: {
    toolCalls: number;
    denials: number;
    replays: number;
    tokens: Partial<Record<(typeof TOKENS)[number], number>>;
    costUsd: number;
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
    results: new Map(),
    loops: new Map(),
    routes: [],
    journaledSinceRoute: false,
    totals: { toolCalls: 0, denials: 0, replays: 0, tokens: {}, costUsd: 0 },
  };
}

/** Folds one event into `state`. */
export function foldEvent(state: SummaryState, event: SailEvent): void {
  state.latestTs = event.ts;
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
    case 'loop:iteration':
      state.feedback = event.feedback?.from;
      raiseLoop(state, event.loop, event.iteration, event.max);
      break;
    case 'loop:exit':
      raiseLoop(state, event.loop, event.iterations, event.max);
      break;
    case 'workflow:route':
      foldRoute(state, event);
      break;
    case 'journal:append':
      state.journaledSinceRoute = true;
  }
}

function foldRunStart(state: SummaryState, event: EventOf<'run:start'>): void {
  if (state.run !== undefined) return;
  const { kind, ticketKey, via } = event.source;
  state.run = {
    runId: event.runId,
    workflow: `${event.workflow.name}@${event.workflow.version}`,
    source: { kind, ticketKey, via },
    startedAt: event.ts,
    maxUsd: event.budget?.maxUsd,
  };
}

function foldRunEnd(state: SummaryState, event: EventOf<'run:end'>): void {
  state.ending = defined<NonNullable<SummaryState['ending']>>({
    status: event.status,
    stopReason: event.stopReason,
    endedAt: event.ts,
    result: event.status === 'completed' ? event.result : undefined,
  });
  state.totals.replays += event.replays;
}

function startCall(state: SummaryState, event: EventOf<'intake:start'> | EventOf<'stage:start'>): void {
  const consumed = Object.values(event.consumed);
  state.calls.set(event.key, {
    key: event.key,
    kind: event.kind,
    startedAt: event.ts,
    facts: {},
    ...(state.feedback !== undefined && consumed.includes(state.feedback) ? { feedback: state.feedback } : {}),
    files: [],
    steps: new Map(),
  });
}

function endCall(state: SummaryState, event: EventOf<'intake:end'> | EventOf<'stage:end'>): void {
  const call = state.calls.get(event.key);
  if (call === undefined) return;
  const durationMs = event.type === 'stage:end' ? event.durationMs : elapsed(call.startedAt, event.ts);
  call.end = { outcome: event.outcome, durationMs, resultPath: event.resultPath };
  state.results.set(event.resultPath, event.key);
}

function startStep(state: SummaryState, event: EventOf<'step:start'>): void {
  state.calls
    .get(callKeyOf(event.key))
    ?.steps.set(event.key, { key: event.key, kind: event.kind, startedAt: event.ts, facts: {}, files: [] });
}

function endStep(state: SummaryState, event: EventOf<'step:end'>): void {
  const step = state.calls.get(callKeyOf(event.key))?.steps.get(event.key);
  if (step === undefined) return;
  step.end = { outcome: event.outcome, durationMs: elapsed(step.startedAt, event.ts) };
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

/** Frontier events repeat after a resume, so a loop keeps the highest iteration any of them reported. */
function raiseLoop(state: SummaryState, name: string, iterations: number, max: number): void {
  state.loops.set(name, { iterations: Math.max(state.loops.get(name)?.iterations ?? 0, iterations), max });
}

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
  const costUsd = round(totals.costUsd);
  return defined<Summary>({
    schema: 'sail.summary.v1',
    runId: run.runId,
    workflow: run.workflow,
    source: { ...run.source },
    status: ending?.status ?? 'running',
    stopReason: ending?.stopReason,
    startedAt: run.startedAt,
    endedAt: ending?.endedAt,
    durationMs: elapsed(run.startedAt, ending?.endedAt ?? state.latestTs ?? run.startedAt),
    result: ending?.result,
    calls: ended.map((call) => callEntry(state, call)),
    loops: Object.fromEntries([...state.loops].map(([name, loop]) => [name, { ...loop }])),
    routes: state.routes.map((route) => ({ ...route })),
    totals: defined<Summary['totals']>({
      stageCalls: ended.length,
      steps: ended.reduce((sum, call) => sum + (call.kind === 'stage' ? endedSteps(call).length : 1), 0),
      toolCalls: totals.toolCalls,
      denials: totals.denials,
      replays: totals.replays,
      usage: defined<Usage>({ ...totals.tokens, costUsd }),
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
  const steps = endedSteps(call);
  const facts: Facts = call.kind === 'stage' ? { costUsd: stepsCost(call) } : call.facts;
  const pointer = call.feedback;
  return defined<CallEntry>({
    key: call.key,
    kind: call.kind === 'stage' ? undefined : call.kind,
    outcome: end.outcome,
    durationMs: end.durationMs,
    turns: facts.turns,
    toolCalls: facts.toolCalls,
    denials: facts.denials,
    costUsd: facts.costUsd,
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
    outcome: step.end.outcome,
    durationMs: step.end.durationMs,
    turns: step.facts.turns,
    toolCalls: step.facts.toolCalls,
    costUsd: step.facts.costUsd,
    files: step.files.length > 0 ? [...step.files] : undefined,
  });
}

// The event union: every line of a run's event stream, typed. It mirrors `sail.event.v1`, and
// test/events/types.test.ts keeps the two in step. Each event is the envelope `{ seq, ts, type, runId }` with its
// payload beside it. The families the engine emits have closed payloads, and a call-level event carries the key of the
// call it belongs to. So do the provider families the port adapters emit: ticket:*, codehost:* and workspace:*, and the
// families a harness emits, which the agent kind stamps with its call's key. The families later epics emit are declared
// with open payloads, and close as they are built (ADR-0012). Types only, apart from `EVENT_TYPES`, so importing this
// module does nothing.
import type { ContractError } from '../engine/contract';
import type { JournalEntry } from '../engine/journal';
import type { IntakeEntry, RosterEntry } from '../engine/roster';
import type { StopReason } from '../engine/run-dir';
import type { RunHeader } from '../engine/run-header';
import type { CheckStatus, MergeMethod, TicketMove, TicketState, Usage } from '../ports/types';
import type { Budget, Permissions } from '../sdk/steps';

/** Every event type, in `sail.event.v1`'s order. */
export const EVENT_TYPES = [
  'run:start',
  'run:end',
  'run:adopted',
  'run:resumed',
  'intake:start',
  'intake:end',
  'stage:start',
  'stage:end',
  'step:start',
  'step:end',
  'loop:iteration',
  'loop:exit',
  'all:start',
  'all:end',
  'workflow:route',
  'journal:append',
  'agent:message',
  'agent:thinking',
  'harness:session_start',
  'harness:session_end',
  'tool:start',
  'tool:end',
  'permission:denied',
  'script:exec',
  'script:exit',
  'input:materialised',
  'prompt:rendered',
  'output:validated',
  'output:invalid',
  'file:produced',
  'file:validated',
  'usage:update',
  'budget:warning',
  'budget:exceeded',
  'ticket:fetched',
  'ticket:claimed',
  'ticket:updated',
  'ticket:commented',
  'codehost:pushed',
  'codehost:pr_opened',
  'codehost:checks',
  'codehost:labelled',
  'codehost:commented',
  'codehost:merged',
  'workspace:leased',
  'workspace:lease_released',
  'workspace:created',
  'workspace:released',
  'error:harness',
  'error:timeout',
  'error:crash',
  'error:consumer',
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

/** What the bus stamps on every event. */
export interface Envelope {
  /** 1, 2, 3… in the run's events file, without a gap. */
  seq: number;
  /** ISO 8601, UTC. */
  ts: string;
  runId: string;
}

type Outcome = JournalEntry['outcome'];

/** Binding → where it came from, as `result.json`'s `consumed` records it. */
type Consumed = Record<string, string | null>;

/** The payload of each type this phase closes. A call-level type requires `key`, `<stage>#<call>[/<step>]`. */
interface Payloads {
  'run:start': {
    source: RunHeader['source'];
    workflow: RunHeader['workflow'];
    roster: { intake: IntakeEntry; stages: Record<string, RosterEntry> };
    adapters: RunHeader['adapters'];
    budget?: RunHeader['budget'];
  };
  'run:end': {
    status: 'completed' | 'failed' | 'suspended';
    /** Exactly when the run failed or was suspended. */
    stopReason?: StopReason;
    message?: string;
    /** What the workflow returned, when it completed. */
    result?: unknown;
    /** The replays this process ran. */
    replays: number;
  };
  'stage:start': {
    key: string;
    stage: string;
    call: number;
    try: number;
    kind: 'agent' | 'script' | 'stage';
    consumed: Consumed;
    model?: string;
    permissions?: Permissions;
    budget?: Budget;
    steps?: string[];
  };
  'stage:end': {
    key: string;
    stage: string;
    call: number;
    try: number;
    outcome: Outcome;
    durationMs: number;
    /** Relative to the run directory. */
    resultPath: string;
    /** Exactly when the outcome is `error`. */
    errors?: ContractError[];
  };
  'intake:start': { key: string; intake: string; kind: 'agent' | 'script'; origin: string; consumed: Consumed };
  'intake:end': { key: string; outcome: Outcome; resultPath: string };
  'step:start': {
    key: string;
    stage: string;
    step: string;
    index: number;
    of: number;
    kind: 'agent' | 'script';
    model?: string;
    command?: string;
  };
  'step:end': { key: string; step: string; outcome: Outcome; resultPath: string };
  'input:materialised': { key: string; binding: string; from: string };
  'prompt:rendered': {
    key: string;
    try: number;
    /** `prompt.md`, relative to the run directory. */
    path: string;
    /** The untrusted values the prompt prints. */
    untrusted: number;
    fragments: { name: string; origin: string }[];
    /** The convention files appended, each relative to the workspace. */
    conventions: string[];
  };
  'script:exec': {
    key: string;
    /** Relative to the workspace. */
    command: string;
    cwd: string;
    /** The preamble's names, in order. */
    envKeys: string[];
  };
  'script:exit': {
    key: string;
    code: number | null;
    signal?: string;
    /** What the exit code maps to, when it has a mapping. */
    outcome?: 'passed' | 'failed' | 'error';
    durationMs: number;
    stdoutBytes: number;
  };
  'output:validated': { key: string };
  'output:invalid': { key: string; message: string };
  'file:produced': { key: string; name: string; path: string; bytes: number; sha256: string };
  'file:validated': { key: string; name: string; ok: boolean; checks: string[] };
  'journal:append': { key: string; line: number; outcome: Outcome };
  'loop:iteration': {
    loop: string;
    iteration: number;
    max: number;
    /** Where the previous pass's feedback came from: a call's output pointer, or `workflow`. */
    feedback?: { from: string };
  };
  'loop:exit': { loop: string; iterations: number; max: number; reason: 'break' | 'exceeded' };
  /** The last journaled call's key and outcome, and what the workflow did next: a call's key, `end` or `fail`. */
  'workflow:route': { at: string; value: Outcome; took: string };
  // The harness families. A harness emits them without a key, and the agent kind stamps its call's.
  'harness:session_start': { key: string; adapter: string; sessionId: string; model: string };
  /** One per session, with what it spent in all. `sessionId` is left out only when the harness reported none. */
  'harness:session_end': {
    key: string;
    sessionId?: string;
    outcome: 'done' | 'blocked' | 'error';
    /** Why the session ended, in the harness's own word, such as `submitted`. */
    reason?: string;
    turns: number;
    toolCalls: number;
    denials: number;
    usage: Usage;
  };
  'agent:message': { key: string; text: string };
  'agent:thinking': { key: string; text: string };
  'tool:start': { key: string; callId: string; tool: string; input: unknown };
  'tool:end': { key: string; callId: string; status: 'completed' | 'denied' | 'failed'; durationMs: number };
  'permission:denied': {
    key: string;
    callId: string;
    tool: string;
    /** The permission that denied the call. */
    rule: 'read' | 'write' | 'commands' | 'network';
    /** The step's permissions under `rule`. */
    permissions: Partial<Permissions>;
    reason: string;
  };
  /** Cumulative within its session: the last one before the session's end is what the session spent. */
  'usage:update': {
    key: string;
    turn: number;
    tokens: { input: number; cacheRead: number; cacheWrite: number; output: number };
    costUsdSoFar: number;
  };
  /** A step's budget carries its call's key, and the run's carries none. */
  'budget:warning': { key?: string; budget: 'turns' | 'usd' | 'minutes'; limit: number; used: number };
  'budget:exceeded': { key?: string; budget: 'turns' | 'usd' | 'minutes'; limit: number; used: number };
  'error:harness': { key: string; message: string };
  'error:timeout': { key: string; message: string; timeoutSeconds: number };
  'error:crash': { message: string; key?: string };
  'error:consumer': { consumer: string; failed: { seq: number; type: EventType }; message: string };
  // The provider families (D10). A ticket or codehost event carries its call's key when a call emitted it, and none at
  // dispatch; a workspace event carries none.
  'ticket:fetched': {
    key?: string;
    ticketKey: string;
    comments: number;
    links: number;
    attachments: number;
    durationMs: number;
  };
  'ticket:claimed': { key?: string; ticketKey: string; state: TicketState };
  'ticket:updated': { key?: string; ticketKey: string; change: { state: TicketMove }; state: TicketState };
  'ticket:commented': { key?: string; ticketKey: string; body: string };
  'codehost:pushed': { key?: string; branch: string; headSha: string };
  'codehost:pr_opened': {
    key?: string;
    number: number;
    url: string;
    draft: boolean;
    base: string;
    head: string;
    ticketKey?: string;
  };
  'codehost:checks': { key?: string; number: number; headSha: string; checks: { name: string; status: CheckStatus }[] };
  'codehost:labelled': { key?: string; number: number; label: string; change: 'added' | 'removed' };
  'codehost:commented': { key?: string; number: number; body: string };
  'codehost:merged': { key?: string; number: number; method: MergeMethod; sha: string };
  /** `took` is the stale run whose lease this one replaced. */
  'workspace:leased': { remote: string; branch: string; took?: string };
  'workspace:lease_released': { remote: string; branch: string };
  'workspace:created': { path: string; branch: string; baseSha: string; durationMs: number };
  'workspace:released': { path: string; kept: boolean };
}

type ClosedType = keyof Payloads;

/** A family a later epic emits: any fields, and a key when it belongs to a call. */
interface OpenPayload {
  key?: string;
  [field: string]: unknown;
}

type PayloadOf<T extends EventType> = T extends ClosedType ? Payloads[T] : OpenPayload;

/** One line of a run's event stream. */
export type SailEvent = { [T in EventType]: Envelope & { type: T } & PayloadOf<T> }[EventType];

/** An event as it is emitted: the bus stamps the envelope. */
export type NewEvent = { [T in EventType]: { type: T } & PayloadOf<T> }[EventType];

/** An event as a step emits it: the call stamps its key. */
export type CallEvent = { [T in EventType]: { type: T } & Omit<PayloadOf<T>, 'key'> }[EventType];

export type Emit = (event: NewEvent) => void;

export type CallEmit = (event: CallEvent) => void;

type ProviderType = Extract<EventType, `ticket:${string}` | `codehost:${string}` | `workspace:${string}`>;

/** An event as an adapter emits it, without the key: its caller stamps one. */
export type ProviderEvent = Extract<CallEvent, { type: ProviderType }>;

export type ProviderEmit = (event: ProviderEvent) => void;

/** Receives the event stream and does one thing with it. A consumer that throws is reported as `error:consumer`. */
export interface Consumer {
  readonly name: string;
  onEvent(event: SailEvent): void;
}

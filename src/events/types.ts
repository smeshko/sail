// The event union: every line of a run's event stream, typed. It mirrors `sail.event.v1`, and
// test/events/types.test.ts keeps the two in step. Each event is the envelope `{ seq, ts, type, runId }` with its
// payload beside it. Every type has a closed payload here, and a call-level event carries the key of the call it belongs
// to. So do the provider families the port adapters emit: ticket:*, codehost:* and workspace:*, and the families a
// harness emits, which the agent kind stamps with its call's key. A group's all:start and all:end carry its keys and no
// key of their own: a group is not a call. The schema still leaves some families open for the adapters to come
// (ADR-0012), but nothing emits them other than as typed here. Types only, apart from `EVENT_TYPES` and
// `QUEUE_EVENT_TYPES`, so importing this module does nothing.
import type { ContractError } from '../engine/contract';
import type { JournalEntry } from '../engine/journal';
import type { IntakeEntry, RosterEntry } from '../engine/roster';
import type { StopReason } from '../engine/run-dir';
import type { RunHeader } from '../engine/run-header';
import type { PortErrorCode } from '../ports/errors';
import type { CheckStatus, MergeMethod, TicketMove, TicketState, Usage } from '../ports/types';
import type { Budget, Permissions } from '../sdk/steps';

/** Every type a run's event stream carries, in `sail.event.v1`'s order. A queue's follow in the schema's enum. */
export const EVENT_TYPES = [
  'run:start',
  'run:end',
  'run:suspended',
  'run:keep_awake',
  'intake:start',
  'intake:end',
  'stage:start',
  'stage:end',
  'step:start',
  'step:end',
  'step:queued',
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
  'budget:raised',
  'ticket:fetched',
  'ticket:claimed',
  'ticket:updated',
  'ticket:commented',
  'ticket:created',
  'ticket:attached',
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
  'error:port',
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

/** The payload of each type. A call-level type requires `key`, `<stage>#<call>[/<step>]`. */
interface Payloads {
  'run:start': {
    source: RunHeader['source'];
    workflow: RunHeader['workflow'];
    roster: { intake: IntakeEntry; stages: Record<string, RosterEntry> };
    adapters: RunHeader['adapters'];
    budget?: RunHeader['budget'];
    /** The run a seeded run reused calls from. */
    fromRun?: string;
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
  /** A run suspended on its budget, right before its `run:end`: which budget, its limit and what was used. */
  'run:suspended': { stopReason: 'budget_exceeded'; budget: 'usd' | 'minutes'; limit: number; used: number };
  /** Whether the process driving the run holds a keep-awake: once per process, with no key. */
  'run:keep_awake': { held: true; by: string } | { held: false; reason: string };
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
  'intake:start': {
    key: string;
    intake: string;
    kind: 'agent' | 'script' | 'stage' | 'builtin';
    steps?: string[];
    origin: string;
    consumed: Consumed;
  };
  'intake:end': { key: string; outcome: Outcome; resultPath: string };
  'step:start': {
    key: string;
    stage: string;
    step: string;
    index: number;
    of: number;
    kind: 'agent' | 'script';
    /** The step's try: 1, unless an interruption or a correction gave it a later one. */
    try: number;
    model?: string;
    command?: string;
  };
  'step:end': {
    key: string;
    step: string;
    try: number;
    outcome: Outcome;
    /** Relative to the run directory. */
    resultPath: string;
    /** Exactly when the outcome is `error`. */
    errors?: ContractError[];
  };
  'step:queued': {
    key: string;
    /** The exclusive slot the step waits for. */
    exclusive: string;
    /** The run and call that hold the slot now. */
    holder: { runId: string; key: string; pid: number; takenAt: string };
  };
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
    /** The preamble's names, in order, then `SAIL_EVENTS`. */
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
  'journal:append': {
    key: string;
    line: number;
    outcome: Outcome;
    /** Marks a reused call: the run it was taken from. */
    fromRun?: string;
    /** Present only on a reused intake's line: the run's ticket, its title untrusted text. */
    ticket?: { ticketKey: string; title: string; url: string };
  };
  'loop:iteration': {
    loop: string;
    iteration: number;
    max: number;
    /** Where the previous pass's feedback came from: a call's output pointer, or `workflow`. */
    feedback?: { from: string };
  };
  'loop:exit': { loop: string; iterations: number; max: number; reason: 'break' | 'exceeded' };
  /** A group starting: its keys in declaration order, and the ones this process starts now, all of them unless resumed. */
  'all:start': { keys: string[]; running: string[] };
  /** A group whose every call is journaled: each call's outcome, and how long the group took in this process. */
  'all:end': { keys: string[]; outcomes: Record<string, Outcome>; durationMs: number };
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
  'tool:end': {
    key: string;
    callId: string;
    status: 'completed' | 'denied' | 'failed';
    durationMs: number;
    /** The start of the text the tool returned, when it returned any. */
    result?: string;
  };
  'permission:denied': {
    key: string;
    callId: string;
    tool: string;
    /** The permission that denied the call. */
    rule: 'read' | 'write' | 'commands' | 'network' | 'tools';
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
  /** A raise given to `sail resume`: what it added, at least one of the two, and the run's budget after it. */
  'budget:raised': { usd?: number; minutes?: number; budget: NonNullable<RunHeader['budget']> };
  'error:harness': { key: string; message: string };
  'error:timeout': { key: string; message: string; timeoutSeconds: number };
  'error:crash': { message: string; key?: string };
  'error:consumer': { consumer: string; failed: { seq: number; type: EventType }; message: string };
  /** A port call of a script step's `sail port` that failed, with the port's own message (DECISIONS D3). */
  'error:port': { key?: string; port: 'ticketSource' | 'codeHost'; op: string; code: PortErrorCode; message: string };
  // The provider families (D10). A ticket or codehost event carries its call's key when a call emitted it, and none at
  // dispatch; a workspace event carries none.
  'ticket:fetched': {
    key?: string;
    ticketKey: string;
    /** The ticket's title, as the provider gave it: untrusted text. */
    title: string;
    url: string;
    comments: number;
    links: number;
    attachments: number;
    durationMs: number;
  };
  'ticket:claimed': { key?: string; ticketKey: string; state: TicketState };
  'ticket:updated': { key?: string; ticketKey: string; change: { state: TicketMove }; state: TicketState };
  'ticket:commented': { key?: string; ticketKey: string; body: string };
  /** A ticket `create` filed. Its title is the workflow's own text. */
  'ticket:created': { key?: string; ticketKey: string; title: string; url: string };
  /** A file `attach` attached: its name, content type and size in bytes, and the attachment's URL. */
  'ticket:attached': { key?: string; ticketKey: string; name: string; contentType: string; size: number; url: string };
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
  /** `ref` is where a removed workspace's commits are kept, at `head`, when its `HEAD` had moved past its base. */
  'workspace:released': { path: string; kept: boolean; ref?: string; head?: string };
}

type PayloadOf<T extends EventType> = Payloads[T];

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

/** A failed port call, as `sail port` reports it into the port events file: its caller stamps the key. */
export type PortErrorEvent = Extract<CallEvent, { type: 'error:port' }>;

/** Receives the event stream and does one thing with it. A consumer that throws is reported as `error:consumer`. */
export interface Consumer {
  readonly name: string;
  onEvent(event: SailEvent): void;
}

/**
 * Every type a watched workflow's queue event stream carries, after `EVENT_TYPES` in `sail.event.v1`'s enum. Each has
 * a closed payload: the watch set's changes, the polls, queued items, dispatches, lease skips, drops, parking, errors,
 * and what the watcher did with a dispatched run it found: adopted it, or resumed it. Then a requeue by hand.
 */
export const QUEUE_EVENT_TYPES = [
  'watch:added',
  'watch:removed',
  'queue:polled',
  'queue:item_added',
  'queue:dispatched',
  'queue:skipped_leased',
  'queue:dropped',
  'queue:parked',
  'queue:error',
  'run:adopted',
  'run:resumed',
  'queue:requeued',
] as const;
export type QueueEventType = (typeof QUEUE_EVENT_TYPES)[number];

/** What a queue event stream stamps on every event: the run's envelope without `runId`. */
export interface QueueEnvelope {
  /** 1, 2, 3… in the queue's events file, without a gap across restarts. */
  seq: number;
  /** ISO 8601, UTC. */
  ts: string;
}

/** The queue payloads, all closed. Each names the watched workflow it belongs to. */
export interface QueuePayloads {
  /** The watcher `pid` added the workflow to its watch set, polling `label` every `everyMs`. */
  'watch:added': { workflow: string; pid: number; label: string; everyMs: number; maxConcurrentRuns: number };
  /** The watcher `pid` took the workflow out of its watch set, or stopped. */
  'watch:removed': { workflow: string; pid: number };
  'queue:polled': {
    workflow: string;
    kind: 'ticket' | 'pr';
    label: string;
    found: number;
    added: number;
    durationMs: number;
  };
  /** The title is the provider's: untrusted text. */
  'queue:item_added': {
    workflow: string;
    dedupKey: string;
    source: { kind: 'ticket'; ticketKey: string } | { kind: 'pr'; number: number; headSha: string; branch: string };
    title: string;
  };
  /**
   * Run `run` started for the item, as process `pid`: its `attempt`th dispatch. The field isn't `runId`: a queue event
   * belongs to its workflow, and its envelope has no run.
   */
  'queue:dispatched': { workflow: string; dedupKey: string; run: string; attempt: number; pid: number };
  /** A due item left queued because run `heldBy` holds its branch's lease: it used no slot and counted no attempt. */
  'queue:skipped_leased': { workflow: string; dedupKey: string; branch: string; heldBy: string };
  /** An item taken out of the queue: its re-check found it no longer designated or unstarted. */
  'queue:dropped': { workflow: string; dedupKey: string; reason: string };
  'queue:parked': { workflow: string; dedupKey: string; attempts: number; reason: string };
  /** `retryInMs` is given exactly when the workflow isn't paused. */
  'queue:error': {
    workflow: string;
    port: 'ticketSource' | 'codeHost';
    adapter: string;
    code?: PortErrorCode;
    message: string;
    paused: boolean;
    retryInMs?: number;
  };
  /** The watcher took charge of run `run`, alive as process `pid`: one it dispatched, or one a resume started. */
  'run:adopted': { workflow: string; dedupKey: string; run: string; pid: number };
  /**
   * The watcher started `sail resume <run>` as process `pid`, for a run it found `running` with its process gone, or
   * `suspended` with `interrupted` or `unwatched`.
   */
  'run:resumed': { workflow: string; dedupKey: string; run: string; pid: number; from: ResumedFrom };
  /** A parked or failed item put back in the queue by hand, with no attempts. */
  'queue:requeued': { workflow: string; dedupKey: string; reason: string };
}

/** Where a resumed run was: running with its process gone, or suspended, with why. */
export type ResumedFrom = { status: 'running' } | { status: 'suspended'; stopReason: 'interrupted' | 'unwatched' };

type QueuePayloadOf<T extends QueueEventType> = QueuePayloads[T];

/** One line of a queue's event stream. */
export type QueueEvent = {
  [T in QueueEventType]: QueueEnvelope & { type: T } & QueuePayloadOf<T>;
}[QueueEventType];

/** A queue event as it is emitted: the stream stamps the envelope. */
export type NewQueueEvent = { [T in QueueEventType]: { type: T } & QueuePayloadOf<T> }[QueueEventType];

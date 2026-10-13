// A run's events written by hand: each builder gives one event as it is emitted, and stamp() numbers and times them as
// the bus would. Keys are `<stage>#<call>`, and a call's result sits at `<stage>/call-<n>[/try-<m>]/result.json`.
import type { JournalEntry } from '../../src/engine/journal';
import type { NewEvent, SailEvent } from '../../src/events/types';

export const RUN_ID = 'FAKE-1-01M3BWNZM08Q4T6V2XRJ5KWD3N';

type Outcome = JournalEntry['outcome'];

const START = Date.parse('2026-09-29T09:00:00.000Z');

/** The ts `ms` after the run's start. */
export const at = (ms: number): string => new Date(START + ms).toISOString();

/** `[ms, event]` pairs, stamped as the bus would: `seq` 1, 2, 3… in order, the run's id, and each one's ts. */
export function stamp(...list: [number, NewEvent][]): SailEvent[] {
  return list.map(([ms, event], i) => ({ seq: i + 1, ts: at(ms), runId: RUN_ID, ...event }) as SailEvent);
}

/** Each event as its `events.ndjson` line. */
export const ndjson = (events: readonly SailEvent[]): string =>
  events.map((event) => `${JSON.stringify(event)}\n`).join('');

const fake = { use: 'fake', origin: 'builtin' };

/** The run's `run:start`, from a `ticket-to-pr` v1 run of `FAKE-1`, with `budget` when given. */
export const runStart = (budget?: { maxUsd?: number; maxMinutes?: number }): NewEvent => ({
  type: 'run:start',
  source: { kind: 'ticket', ticketKey: 'FAKE-1', via: 'cli', forced: [] },
  workflow: { name: 'ticket-to-pr', version: 1, origin: 'repo:.sail/workflows/ticket-to-pr', sha256: '0'.repeat(64) },
  roster: { intake: { name: 'ticket', kind: 'script', origin: 'builtin' }, stages: {} },
  adapters: { ticketSource: fake, codeHost: fake, harness: fake, workspace: fake },
  ...(budget === undefined ? {} : { budget }),
});

/** A `run:end`: a stop reason exactly when `status` isn't `completed`. */
export const runEnd = (
  status: 'completed' | 'failed' | 'suspended',
  replays: number,
  extra: { stopReason?: 'workflow_failed' | 'interrupted'; message?: string; result?: unknown } = {},
): NewEvent => ({ type: 'run:end', status, ...extra, replays });

const stageOf = (key: string) => key.split('#')[0] ?? '';
const callOf = (key: string) => Number(key.split('#')[1]?.split('/')[0]);

/** Where a call's try keeps its `result.json`. */
export const resultPath = (key: string, tryNumber = 1): string =>
  `${stageOf(key)}/call-${callOf(key)}${tryNumber > 1 ? `/try-${tryNumber}` : ''}/result.json`;

export interface StartOptions {
  kind?: 'agent' | 'script' | 'stage';
  try?: number;
  consumed?: Record<string, string | null>;
  steps?: string[];
}

/** A call's `stage:start`: a script's first try, consuming nothing, unless `options` say otherwise. */
export const start = (key: string, options: StartOptions = {}): NewEvent => ({
  type: 'stage:start',
  key,
  stage: stageOf(key),
  call: callOf(key),
  try: options.try ?? 1,
  kind: options.kind ?? 'script',
  consumed: options.consumed ?? {},
  ...(options.steps === undefined ? {} : { steps: options.steps }),
});

/** A call's `stage:end`, reporting `durationMs`. An `error` carries one interrupted `exit_code` error. */
export const end = (key: string, outcome: Outcome, durationMs: number, tryNumber = 1): NewEvent => ({
  type: 'stage:end',
  key,
  stage: stageOf(key),
  call: callOf(key),
  try: tryNumber,
  outcome,
  durationMs,
  resultPath: resultPath(key, tryNumber),
  ...(outcome === 'error' ? { errors: [{ reason: 'exit_code' as const, message: 'interrupted' }] } : {}),
});

/** The step `<stage>#<call>/<step>`'s `step:start`, the `index`th of `of`. */
export const stepStart = (key: string, index: number, of: number, kind: 'agent' | 'script'): NewEvent => ({
  type: 'step:start',
  key,
  stage: stageOf(key),
  step: key.split('/')[1] ?? '',
  index,
  of,
  kind,
});

/** A step's `step:end`. */
export const stepEnd = (key: string, index: number, outcome: Outcome): NewEvent => ({
  type: 'step:end',
  key,
  step: key.split('/')[1] ?? '',
  outcome,
  resultPath: `${stageOf(key)}/call-${callOf(key)}/steps/${index}-${key.split('/')[1]}/result.json`,
});

export const journal = (key: string, line: number, outcome: Outcome): NewEvent => ({
  type: 'journal:append',
  key,
  line,
  outcome,
});

/** A file the call `key` produced. */
export const produced = (key: string, name: string): NewEvent => ({
  type: 'file:produced',
  key,
  name,
  path: `${stageOf(key)}/call-${callOf(key)}/${name}`,
  bytes: 1,
  sha256: '0'.repeat(64),
});

/** The end of an agent session that submitted, with the facts it reports: any at all, as an events file may hold. */
export const session = (key: string, facts: Record<string, unknown>): NewEvent =>
  ({
    type: 'harness:session_end',
    key,
    sessionId: `session-${key}`,
    outcome: 'done',
    reason: 'submitted',
    ...facts,
  }) as NewEvent;

export const route = (from: string, value: Outcome, took: string): NewEvent => ({
  type: 'workflow:route',
  at: from,
  value,
  took,
});

/** A `ticket:fetched` for `FAKE-1`, under `key` when one is given: the intake's, or a script step's own fetch. */
export const fetched = (key: string | undefined, title: string, url = 'fake://tickets/FAKE-1'): NewEvent => ({
  type: 'ticket:fetched',
  ...(key === undefined ? {} : { key }),
  ticketKey: 'FAKE-1',
  title,
  url,
  comments: 1,
  links: 0,
  attachments: 0,
  durationMs: 310,
});

// What a real harness and a multi-step stage report, which no run writes yet: built by hand until one does.

/** What an agent thought, as its harness reports it. */
export const thinking = (key: string, text: string): NewEvent => ({ type: 'agent:thinking', key, text });

/** The start of the tool call `callId` of the session under `key`. */
export const toolStart = (key: string, callId: string, tool: string, input: unknown): NewEvent => ({
  type: 'tool:start',
  key,
  callId,
  tool,
  input,
});

/** The end of the tool call `callId`: completed, denied by the step's permissions, or failed. */
export const toolEnd = (
  key: string,
  callId: string,
  status: 'completed' | 'denied' | 'failed',
  durationMs: number,
): NewEvent => ({ type: 'tool:end', key, callId, status, durationMs });

/** A Bash call the step's `commands` permission denied, with the reason the harness gave. */
export const denied = (key: string, callId: string, commands: string[], reason: string): NewEvent => ({
  type: 'permission:denied',
  key,
  callId,
  tool: 'Bash',
  rule: 'commands',
  permissions: { commands },
  reason,
});

/** A produced file's verdict, with the checks it was held to. */
export const validated = (key: string, name: string, checks: string[], ok = true): NewEvent => ({
  type: 'file:validated',
  key,
  name,
  ok,
  checks,
});

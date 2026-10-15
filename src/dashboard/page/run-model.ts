// A run's events folded into what the run view shows: one stage card per call, in the order calls start, then a pending
// card for each roster stage not called yet, in the roster's order. Nothing here names a stage: the roster in
// `run:start` is the only stage list, so a workflow with a stage the page has never seen shows it with no page change.
//
// The fold is fed by events only, so a replay and a live follow build the same model. It is defensive: events come from
// a file nothing re-validates on read, so every field is checked before use. An event whose fields don't fit is counted
// as unreadable, and a type the fold doesn't handle is counted on its card, or on the run when it has none. Nothing
// here throws.
import type { RosterEntry } from '../../engine/roster';
import type { SailEvent } from '../../events/types';
import { text } from './html';

export type CardKind = 'agent' | 'script' | 'stage' | 'builtin';

/** A tool call the step's permissions refused, with the command it asked for when its `tool:start` said. */
export interface Denial {
  seq: number;
  ts: string;
  callId: string;
  tool: string;
  rule: string;
  /** The step's permissions under `rule`. */
  permissions: Record<string, unknown>;
  reason: string;
  command?: string;
}

/** A file a call produced or validated. */
export interface CardFile {
  name: string;
  path?: string;
  bytes?: number;
  sha256?: string;
  ok?: boolean;
  checks?: string[];
}

export interface CardStep {
  step: string;
  index: number;
  of: number;
  kind: string;
  outcome?: string;
}

/** What a call's harness sessions have spent: the ended ones in all, and the one still going. */
interface Sessions {
  costEnded: number;
  costLive: number;
  turnsEnded: number;
  turnLive: number;
  toolsEnded: number;
  toolsLive: number;
  /** Whether any session started, or any usage was reported. */
  seen: boolean;
}

/** One call's card. */
export interface StageCard {
  key: string;
  stage: string;
  call: number;
  kind: CardKind;
  state: 'running' | 'settled';
  outcome?: string;
  tries: number;
  model?: string;
  startedAt: string;
  durationMs?: number;
  costUsd?: number;
  turns?: number;
  toolCalls: number;
  denials: Denial[];
  files: CardFile[];
  errors?: { reason: string; message: string }[];
  steps: CardStep[];
  /** The loop iteration open when the call started, the innermost when loops nest. */
  iteration?: { loop: string; iteration: number; max: number };
  resultPath?: string;
  /** The call's last agent message. */
  message?: string;
  /** How many events carried its key. */
  events: number;
  /** Event types the fold doesn't handle, by type. */
  other: Record<string, number>;
  sessions: Sessions;
}

/** A roster stage the run hasn't called yet. */
export interface PendingCard {
  stage: string;
  kind: 'agent' | 'script' | 'stage';
  model?: string;
}

export interface Roster {
  intake: RosterEntry & { name: string };
  stages: Record<string, RosterEntry>;
}

type RunStart = Extract<SailEvent, { type: 'run:start' }>;

export interface RunModel {
  runId?: string;
  /** `name@version`. */
  workflow?: string;
  source?: RunStart['source'];
  startedAt?: string;
  budget?: { maxUsd?: number; maxMinutes?: number };
  roster?: Roster;
  /** The run's ticket, from the intake's `ticket:fetched`. */
  ticket?: { ticketKey: string; title: string; url: string };
  cards: StageCard[];
  pending: PendingCard[];
  loops: Record<string, { iteration: number; max: number; exited?: 'break' | 'exceeded' }>;
  /** The loops open now, innermost last. */
  openLoops: string[];
  routes: { at: string; value: string; took: string }[];
  end?: { status: string; stopReason?: string; message?: string };
  /** The `ts` of the `run:end` in `end`. */
  endedAt?: string;
  pr?: { number: number; url: string };
  /** The intake's key, once its call started. */
  intakeKey?: string;
  /** Each tool call's input, by call id, so a denial can name its command. */
  toolInputs: Record<string, unknown>;
  lastSeq: number;
  /** Events whose fields don't fit their type. */
  unreadable: number;
  /** Types the fold doesn't handle, on events with no card, by type. */
  other: Record<string, number>;
}

/**
 * A map keyed by run text, with no prototype: a loop, a tool call or an event type named `__proto__` or `constructor`
 * is its own key, never Object.prototype's (review R1-5).
 */
const dict = <T>(): Record<string, T> => Object.create(null) as Record<string, T>;

export function emptyRun(): RunModel {
  return {
    cards: [],
    pending: [],
    loops: dict(),
    openLoops: [],
    routes: [],
    toolInputs: dict(),
    lastSeq: 0,
    unreadable: 0,
    other: dict(),
  };
}

type Fields = Record<string, unknown>;

const str = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);
const num = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined;
const obj = (value: unknown): Fields | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Fields) : undefined;
const strings = (value: unknown): string[] | undefined =>
  Array.isArray(value) && value.every((item) => typeof item === 'string') ? value : undefined;

/**
 * The engine's own bookkeeping, which a card has nothing to show for: handled by being passed over, so that `other`
 * holds only what the page doesn't know.
 */
const PASSED_OVER = new Set([
  'run:adopted',
  'run:resumed',
  'journal:append',
  'input:materialised',
  'prompt:rendered',
  'output:validated',
  'script:exec',
  'script:exit',
  'workspace:leased',
  'workspace:lease_released',
  'workspace:created',
  'workspace:released',
  'ticket:claimed',
  'ticket:commented',
]);

const STAGE_KINDS = new Set(['agent', 'script', 'stage']);
const INTAKE_KINDS = new Set(['agent', 'script', 'builtin']);

/** The command a tool call asked for: `input.command` when it is text, else the input as JSON, cut to 200 characters. */
function commandOf(input: unknown): string | undefined {
  if (input === undefined) return undefined;
  const command = str(obj(input)?.command);
  if (command !== undefined) return command;
  const shown = text(input);
  return shown.length > 200 ? `${shown.slice(0, 200)}…` : shown;
}

function newCard(
  model: RunModel,
  fields: { key: string; stage: string; call: number; kind: CardKind; startedAt: string },
) {
  const open = model.openLoops.at(-1);
  const loop = open === undefined ? undefined : model.loops[open];
  const card: StageCard = {
    ...fields,
    state: 'running',
    tries: 1,
    toolCalls: 0,
    denials: [],
    files: [],
    steps: [],
    events: 0,
    other: dict(),
    sessions: { costEnded: 0, costLive: 0, turnsEnded: 0, turnLive: 0, toolsEnded: 0, toolsLive: 0, seen: false },
  };
  if (open !== undefined && loop !== undefined)
    card.iteration = { loop: open, iteration: loop.iteration, max: loop.max };
  model.cards.push(card);
  return card;
}

/** Brings the card's cost, turns and tool calls up to date with its sessions. */
function meter(card: StageCard): void {
  const { sessions } = card;
  card.toolCalls = sessions.toolsEnded + sessions.toolsLive;
  if (!sessions.seen) return;
  card.costUsd = sessions.costEnded + sessions.costLive;
  card.turns = sessions.turnsEnded + sessions.turnLive;
}

/** Ends the card's live session, with what its end says it spent where it says. */
function endSession(card: StageCard, end?: Fields): void {
  const { sessions } = card;
  sessions.costEnded += num(obj(end?.usage)?.costUsd) ?? sessions.costLive;
  sessions.turnsEnded += num(end?.turns) ?? sessions.turnLive;
  sessions.toolsEnded += num(end?.toolCalls) ?? sessions.toolsLive;
  sessions.costLive = 0;
  sessions.turnLive = 0;
  sessions.toolsLive = 0;
}

function upsertFile(card: StageCard, name: string, fields: Omit<CardFile, 'name'>): void {
  const file = card.files.find((entry) => entry.name === name);
  if (file === undefined) card.files.push({ name, ...fields });
  else Object.assign(file, fields);
}

/** The roster stages with no card, in the roster's order. */
function pendingOf(model: RunModel): PendingCard[] {
  const called = new Set(model.cards.filter((card) => card.key !== model.intakeKey).map((card) => card.stage));
  return Object.entries(model.roster?.stages ?? {})
    .filter(([stage]) => !called.has(stage))
    .map(([stage, entry]) => {
      const given = str(entry.kind);
      const kind = given !== undefined && STAGE_KINDS.has(given) ? (given as PendingCard['kind']) : 'stage';
      const stageModel = str(entry.model);
      return stageModel === undefined ? { stage, kind } : { stage, kind, model: stageModel };
    });
}

const count = (counts: Record<string, number>, type: string) => {
  counts[type] = (counts[type] ?? 0) + 1;
};

/** Folds one event into `model`. Never throws: an event that doesn't fit is counted as unreadable. */
export function applyEvent(model: RunModel, event: unknown): void {
  const e = obj(event);
  const type = str(e?.type);
  if (e === undefined || type === undefined) {
    model.unreadable++;
    return;
  }
  const seq = num(e.seq);
  if (seq !== undefined && seq > model.lastSeq) model.lastSeq = seq;
  const ts = str(e.ts) ?? '';
  const key = str(e.key);
  const card = key === undefined ? undefined : model.cards.find((entry) => entry.key === key.split('/')[0]);
  if (card !== undefined) card.events++;
  // A run:end with more of the run after it, other than a consumer's report, was a stop the run was resumed from, as
  // the follow reads it (src/events/follow.ts): the run is live again (review R1-2).
  if (model.end !== undefined && type !== 'run:end' && type !== 'error:consumer') {
    delete model.end;
    delete model.endedAt;
  }
  if (!fold(model, e, type, ts, key, card)) model.unreadable++;
  else if (type === 'run:start' || type === 'stage:start') model.pending = pendingOf(model);
}

/** Folds the event, and says whether its fields fit. */
function fold(model: RunModel, e: Fields, type: string, ts: string, key?: string, card?: StageCard): boolean {
  switch (type) {
    case 'run:start': {
      const workflow = obj(e.workflow);
      const roster = obj(e.roster);
      const stages = obj(roster?.stages);
      // Every roster entry is read as an object, so a run:start whose entries aren't is unreadable (review R1-4).
      if (roster === undefined || stages === undefined || obj(roster.intake) === undefined) return false;
      if (!Object.values(stages).every((entry) => obj(entry) !== undefined)) return false;
      const runId = str(e.runId);
      const name = str(workflow?.name);
      const version = num(workflow?.version);
      const source = obj(e.source);
      const budget = obj(e.budget);
      if (runId !== undefined) model.runId = runId;
      if (name !== undefined && version !== undefined) model.workflow = `${name}@${version}`;
      if (source !== undefined) model.source = source as RunModel['source'] & object;
      if (budget !== undefined) {
        // Only the limits the view shows, each a finite number (review R2-4).
        const maxUsd = num(budget.maxUsd);
        const maxMinutes = num(budget.maxMinutes);
        model.budget = {
          ...(maxUsd === undefined ? {} : { maxUsd }),
          ...(maxMinutes === undefined ? {} : { maxMinutes }),
        };
      }
      model.startedAt = ts;
      model.roster = roster as unknown as Roster;
      return true;
    }
    case 'run:end': {
      const status = str(e.status);
      if (status === undefined) return false;
      model.end = { status };
      model.endedAt = ts;
      const stopReason = str(e.stopReason);
      const message = str(e.message);
      if (stopReason !== undefined) model.end.stopReason = stopReason;
      if (message !== undefined) model.end.message = message;
      return true;
    }
    case 'intake:start': {
      const kind = str(e.kind);
      const intake = str(e.intake);
      if (key === undefined || intake === undefined || kind === undefined || !INTAKE_KINDS.has(kind)) return false;
      if (card !== undefined) return false;
      newCard(model, { key, stage: intake, call: 1, kind: kind as CardKind, startedAt: ts });
      model.intakeKey = key;
      return true;
    }
    case 'stage:start': {
      const stage = str(e.stage);
      const call = num(e.call);
      const tryNumber = num(e.try);
      const kind = str(e.kind);
      if (key === undefined || stage === undefined || call === undefined || tryNumber === undefined) return false;
      if (kind === undefined || !STAGE_KINDS.has(kind) || key.includes('/')) return false;
      const started = card ?? newCard(model, { key, stage, call, kind: kind as CardKind, startedAt: ts });
      started.state = 'running';
      started.tries = Math.max(started.tries, tryNumber);
      const stageModel = str(e.model) ?? model.roster?.stages[stage]?.model;
      if (stageModel !== undefined) started.model = stageModel;
      return true;
    }
    case 'intake:end':
    case 'stage:end': {
      const outcome = str(e.outcome);
      if (card === undefined || outcome === undefined || key?.includes('/')) return false;
      card.state = 'settled';
      card.outcome = outcome;
      const resultPath = str(e.resultPath);
      if (resultPath !== undefined) card.resultPath = resultPath;
      const durationMs = num(e.durationMs) ?? Date.parse(ts) - Date.parse(card.startedAt);
      if (Number.isFinite(durationMs)) card.durationMs = durationMs;
      const errors = Array.isArray(e.errors) ? e.errors.map(obj) : undefined;
      if (errors !== undefined) {
        card.errors = errors.map((error) => ({ reason: str(error?.reason) ?? '', message: str(error?.message) ?? '' }));
      }
      return true;
    }
    case 'step:start': {
      const step = str(e.step);
      const index = num(e.index);
      const of = num(e.of);
      if (card === undefined || step === undefined || index === undefined || of === undefined) return false;
      const existing = card.steps.find((entry) => entry.step === step);
      const fields = { step, index, of, kind: str(e.kind) ?? '' };
      if (existing === undefined) card.steps.push(fields);
      else Object.assign(existing, fields);
      return true;
    }
    case 'step:end': {
      const step = card?.steps.find((entry) => entry.step === str(e.step));
      const outcome = str(e.outcome);
      if (step === undefined || outcome === undefined) return false;
      step.outcome = outcome;
      return true;
    }
    case 'loop:iteration': {
      const loop = str(e.loop);
      const iteration = num(e.iteration);
      const max = num(e.max);
      if (loop === undefined || iteration === undefined || max === undefined) return false;
      model.loops[loop] = { iteration, max };
      if (!model.openLoops.includes(loop)) model.openLoops.push(loop);
      return true;
    }
    case 'loop:exit': {
      const loop = str(e.loop);
      const iterations = num(e.iterations);
      const max = num(e.max);
      const reason = str(e.reason);
      if (loop === undefined || iterations === undefined || max === undefined) return false;
      if (reason !== 'break' && reason !== 'exceeded') return false;
      model.loops[loop] = { iteration: iterations, max, exited: reason };
      model.openLoops = model.openLoops.filter((name) => name !== loop);
      return true;
    }
    case 'workflow:route': {
      const at = str(e.at);
      const took = str(e.took);
      if (at === undefined || took === undefined) return false;
      model.routes.push({ at, value: text(e.value), took });
      return true;
    }
    case 'harness:session_start': {
      if (card === undefined) return false;
      if (card.sessions.seen) endSession(card);
      card.sessions.seen = true;
      meter(card);
      return true;
    }
    case 'harness:session_end': {
      if (card === undefined) return false;
      card.sessions.seen = true;
      endSession(card, e);
      meter(card);
      return true;
    }
    case 'usage:update': {
      const spent = num(e.costUsdSoFar);
      if (card === undefined || spent === undefined) return false;
      card.sessions.seen = true;
      card.sessions.costLive = spent;
      card.sessions.turnLive = num(e.turn) ?? card.sessions.turnLive;
      meter(card);
      return true;
    }
    case 'tool:start': {
      const callId = str(e.callId);
      if (card === undefined || callId === undefined) return false;
      model.toolInputs[callId] = e.input;
      card.sessions.toolsLive++;
      meter(card);
      return true;
    }
    case 'tool:end':
      return card !== undefined;
    case 'permission:denied': {
      const callId = str(e.callId);
      const tool = str(e.tool);
      const rule = str(e.rule);
      if (card === undefined || callId === undefined || tool === undefined || rule === undefined) return false;
      const denial: Denial = {
        seq: num(e.seq) ?? 0,
        ts,
        callId,
        tool,
        rule,
        permissions: obj(e.permissions) ?? {},
        reason: str(e.reason) ?? '',
      };
      const command = commandOf(model.toolInputs[callId]);
      if (command !== undefined) denial.command = command;
      card.denials.push(denial);
      return true;
    }
    case 'file:produced': {
      const name = str(e.name);
      if (card === undefined || name === undefined) return false;
      const fields: Omit<CardFile, 'name'> = {};
      const path = str(e.path);
      const bytes = num(e.bytes);
      const sha256 = str(e.sha256);
      if (path !== undefined) fields.path = path;
      if (bytes !== undefined) fields.bytes = bytes;
      if (sha256 !== undefined) fields.sha256 = sha256;
      upsertFile(card, name, fields);
      return true;
    }
    case 'file:validated': {
      const name = str(e.name);
      const ok = e.ok;
      if (card === undefined || name === undefined || typeof ok !== 'boolean') return false;
      upsertFile(card, name, { ok, checks: strings(e.checks) ?? [] });
      return true;
    }
    case 'agent:message': {
      const text = str(e.text);
      if (card === undefined || text === undefined) return false;
      card.message = text;
      return true;
    }
    case 'ticket:fetched': {
      if (key === undefined || key !== model.intakeKey || model.ticket !== undefined) break;
      const ticketKey = str(e.ticketKey);
      const title = str(e.title);
      if (ticketKey === undefined || title === undefined) return false;
      model.ticket = { ticketKey, title, url: str(e.url) ?? '' };
      return true;
    }
    case 'codehost:pr_opened': {
      const number = num(e.number);
      const url = str(e.url);
      if (number === undefined || url === undefined) return false;
      model.pr = { number, url };
      return true;
    }
  }
  if (!PASSED_OVER.has(type)) count(card?.other ?? model.other, type);
  return true;
}

/** The model of `events`, folded in order. */
export function foldRun(events: readonly unknown[]): RunModel {
  const model = emptyRun();
  for (const event of events) applyEvent(model, event);
  return model;
}

/** The card's duration: its `durationMs` once settled, or the time since it started while it runs. */
export function elapsedMs(card: StageCard, now: number): number | undefined {
  if (card.durationMs !== undefined) return card.durationMs;
  const started = Date.parse(card.startedAt);
  return Number.isNaN(started) ? undefined : Math.max(0, now - started);
}

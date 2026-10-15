// A run's events folded into what the run view shows: one stage card per call, in the order calls start, then a pending
// card for each roster stage not called yet, in the roster's order. Nothing here names a stage: the roster in
// `run:start` is the only stage list, so a workflow with a stage the page has never seen shows it with no page change.
//
// The fold is fed by events only, so a replay and a live follow build the same model. It is defensive: events come from
// a file nothing re-validates on read, so every field is checked before use. An event whose fields don't fit is counted
// as unreadable, and a type the fold doesn't handle is counted on its card, or on the run when it has none. Nothing
// here throws.
//
// Stub (TASK-004): the model's types, and a fold that folds nothing.
import type { RosterEntry } from '../../engine/roster';
import type { SailEvent } from '../../events/types';

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

export function emptyRun(): RunModel {
  return {
    cards: [],
    pending: [],
    loops: {},
    openLoops: [],
    routes: [],
    toolInputs: {},
    lastSeq: 0,
    unreadable: 0,
    other: {},
  };
}

/** Folds one event into `model`. Never throws: an event that doesn't fit is counted as unreadable. */
export function applyEvent(_model: RunModel, _event: unknown): void {}

/** The model of `events`, folded in order. */
export function foldRun(_events: readonly unknown[]): RunModel {
  return emptyRun();
}

/** The card's duration: its `durationMs` once settled, or the time since it started while it runs. */
export function elapsedMs(_card: StageCard, _now: number): number | undefined {
  return undefined;
}

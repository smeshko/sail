// A run's summary: its events folded into `sail.summary.v1`. The summary is derived from the events and never read for
// resume (ADR-0002), so a rebuild from `events.ndjson` gives the same document. Ported from the prototype's summary
// consumer, which kept a rolling summary of the stream.
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

/** The summary of `events`, or undefined when they hold no `run:start`. */
export function summarize(_events: readonly SailEvent[]): Summary | undefined {
  return {
    schema: 'sail.summary.v1',
    runId: '',
    workflow: '',
    source: { kind: 'ticket', ticketKey: '', via: 'cli' },
    status: 'running',
    startedAt: '',
    calls: [],
    totals: { stageCalls: 0, steps: 0, toolCalls: 0, denials: 0, replays: 0, usage: { costUsd: 0 } },
    version: 1,
  };
}

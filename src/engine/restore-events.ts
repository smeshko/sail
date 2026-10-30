// What a resume restores to the event stream. The events file is synced before each journal line (`journal()` in
// `runtime.ts`), so a journaled call's own events are on disk whenever its line is. What a power cut can still take is
// what follows the last sync: a `journal:append`, emitted after its line, and the run's `run:start` when no journal
// line was ever synced behind it. `lostEvents()` compares the events with the journal and returns those two, and a
// resume emits them once, so each is in the stream exactly once however often the run resumes.
//
// A restored event takes the resume's `ts`, so a restored `run:start` makes the summary's `startedAt` the resume's time.
// The run header's `startedAt` stays the true one.
import { readEvents } from '../events/consumers/ndjson';
import type { NewEvent } from '../events/types';
import { readJournal } from './journal';
import type { OpenedRun } from './open-run';
import type { RunHeader } from './run-header';

/** The `run:start` of the run `header` describes: from the header, never derived again. */
export function runStartOf(header: RunHeader): NewEvent {
  return {
    type: 'run:start',
    source: header.source,
    workflow: header.workflow,
    roster: { intake: header.intake, stages: header.stages },
    adapters: header.adapters,
    ...(header.budget === undefined ? {} : { budget: header.budget }),
    ...(header.fromRun === undefined ? {} : { fromRun: header.fromRun }),
  };
}

/** The events a resume restores: the `run:start` when the stream holds none, and a `journal:append` per unreported line. */
export interface LostEvents {
  start?: NewEvent;
  appends: NewEvent[];
}

/** The `run:start` and `journal:append` events the run's events file lacks, from its journal and header. */
export function lostEvents(opened: Pick<OpenedRun, 'dir' | 'header' | 'sailDir'>): LostEvents {
  const { dir, header } = opened;
  const events = readEvents(dir);
  const reported = new Set(events.flatMap((event) => (event.type === 'journal:append' ? [event.key] : [])));
  return {
    ...(events.some((event) => event.type === 'run:start') ? {} : { start: runStartOf(header) }),
    appends: readJournal(dir).entries.flatMap((entry) =>
      reported.has(entry.key)
        ? []
        : [{ type: 'journal:append' as const, key: entry.key, line: entry.seq, outcome: entry.outcome }],
    ),
  };
}

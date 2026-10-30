// What a resume restores to the event stream. The events file is synced before each journal line (`journal()` in
// `runtime.ts`), so a journaled call's own events are on disk whenever its line is. What a power cut can still take is
// what follows the last sync: a `journal:append`, emitted after its line, and the run's `run:start` when no journal
// line was ever synced behind it. `lostEvents()` compares the events with the journal and returns those two, and a
// resume emits them once, so each is in the stream exactly once however often the run resumes.
//
// A seeded run's reused lines, those up to the header's `reused`, are restored with `fromRun`, and the intake's with the
// source's ticket, as a seeded run reports them at its start.
//
// A restored event takes the resume's `ts`, so a restored `run:start` makes the summary's `startedAt` the resume's time.
// The run header's `startedAt` stays the true one.
import { join } from 'node:path';
import { readEvents } from '../events/consumers/ndjson';
import type { NewEvent } from '../events/types';
import { INTAKE_KEY } from './intake';
import { readJournal } from './journal';
import type { OpenedRun } from './open-run';
import { runsDir } from './run-dir';
import type { RunHeader } from './run-header';
import { sourceTicket } from './seed-run';

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
  const { fromRun, reused = 0 } = header;
  const ticket =
    fromRun === undefined || reused === 0 ? undefined : sourceTicket(join(runsDir(opened.sailDir), fromRun));
  return {
    ...(events.some((event) => event.type === 'run:start') ? {} : { start: runStartOf(header) }),
    appends: readJournal(dir).entries.flatMap((entry): NewEvent[] => {
      if (reported.has(entry.key)) return [];
      const { key, seq: line, outcome } = entry;
      if (fromRun === undefined || line > reused) return [{ type: 'journal:append', key, line, outcome }];
      const named = key === INTAKE_KEY && ticket !== undefined ? { ticket } : {};
      return [{ type: 'journal:append', key, line, outcome, fromRun, ...named }];
    }),
  };
}

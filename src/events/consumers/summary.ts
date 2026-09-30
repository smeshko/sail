// summary.json: the run's summary, rewritten after every call and rebuilt from `events.ndjson` on demand.
//
// - It is written after `run:start`, each `journal:append`, `run:end` and `error:crash`: once per call, and once a crash
//   stops the run, so it keeps the run's last state. Agent events are dense, and a write on each would sync every
//   message.
// - Each write replaces the file atomically through a temp file of this process's own, so a rebuild in another process
//   never shares one with the run.
// - A write that fails throws, and the bus reports it as `error:consumer`. The next write point writes the whole state
//   again. The prototype's summary consumer swallowed such errors (ADR-0012).
// - A resumed run's consumer starts with nothing, so it seeds itself from `events.ndjson` on its first event.
import { basename, join } from 'node:path';
import { replaceFile } from '../../engine/durable';
import { emptyState, foldEvent, type Summary, summarize, toSummary } from '../summary';
import type { Consumer, EventType } from '../types';
import { readEventsFrom } from './ndjson';

export const SUMMARY_FILE = 'summary.json';

/** The events after which `summary.json` is written. */
const WRITE_POINTS: ReadonlySet<EventType> = new Set(['run:start', 'journal:append', 'run:end', 'error:crash']);

/** Writes `summary` as the run's `summary.json`, and gives its path. */
export function writeSummary(runDir: string, summary: Summary): string {
  const path = join(runDir, SUMMARY_FILE);
  replaceFile(path, `${JSON.stringify(summary, null, 2)}\n`, `${path}.${process.pid}.tmp`);
  return path;
}

/** Keeps `summary.json` in `runDir` current with the run's events. A write that fails throws, for the bus to report. */
export function summaryConsumer(runDir: string): Consumer {
  let state = emptyState();
  let seeded = false;
  return {
    name: SUMMARY_FILE,
    onEvent(event) {
      // A fresh run starts at seq 1. A resumed one continues the file, which the events consumer has already appended
      // this event to: fold what came before it. A seed that fails throws, and the next event tries again.
      if (!seeded) {
        if (event.seq > 1) state = seed(runDir, event.seq);
        seeded = true;
      }
      foldEvent(state, event);
      const summary = WRITE_POINTS.has(event.type) ? toSummary(state) : undefined;
      if (summary !== undefined) writeSummary(runDir, summary);
    },
  };
}

/** The fold of the run's events before `seq`. An events file that can't be read throws. */
function seed(runDir: string, seq: number) {
  const read = readEventsFrom(runDir);
  if ('refused' in read) throw new Error(read.refused);
  const state = emptyState();
  for (const event of read.events) if (event.seq < seq) foldEvent(state, event);
  return state;
}

/** Folds the run's whole events file and writes `summary.json` from it. */
export function rebuildSummary(runDir: string): { summary: Summary; path: string } | { refused: string } {
  const read = readEventsFrom(runDir);
  if ('refused' in read) return read;
  const summary = summarize(read.events);
  if (summary === undefined) {
    return { refused: `run ${basename(runDir)}'s events hold no run:start, so there is no summary to build` };
  }
  return { summary, path: writeSummary(runDir, summary) };
}

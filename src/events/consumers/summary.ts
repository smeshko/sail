// summary.json: the run's summary, rewritten after every call and rebuilt from `events.ndjson` on demand.
import type { Summary } from '../summary';
import type { Consumer } from '../types';

export const SUMMARY_FILE = 'summary.json';

/** Keeps `summary.json` in `runDir` current with the run's events. A write that fails throws, for the bus to report. */
export function summaryConsumer(_runDir: string): Consumer {
  return { name: SUMMARY_FILE, onEvent() {} };
}

/** Folds the run's whole events file and writes `summary.json` from it. */
export function rebuildSummary(_runDir: string): { summary: Summary; path: string } | { refused: string } {
  return { refused: 'rebuildSummary is not written yet' };
}

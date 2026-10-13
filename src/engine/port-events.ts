// The port events file: `port-events.ndjson` in a script step's call directory, where a `sail port` the script runs
// leaves the provider events its adapter emitted.
import type { ProviderEvent } from '../events/types';

export const PORT_EVENTS_FILE = 'port-events.ndjson';

/** Appends `event` to the file at `path` as one line, in one write. The file's directory must exist. */
export function appendPortEvent(_path: string, _event: ProviderEvent): void {}

/** The provider events the file at `path` holds, in order, and a problem for each whole line that is none. */
export function readPortEvents(
  _path: string,
  _envelope: { runId: string; key: string },
): { events: ProviderEvent[]; problems: string[] } {
  return { events: [], problems: [] };
}

// Generates the golden run: the run directory under test/fixtures/runs/, and the four terminal views of its events
// under test/fixtures/terminal/.
import type { Verbosity } from '../src/events/consumers/terminal';
import type { SailEvent } from '../src/events/types';

/** The golden run's id. */
export const GOLDEN_RUN_ID = 'FAKE-1-01M3BWNZM08Q4T6V2XRJ5KWD3N';
export const VERBOSITIES: readonly Verbosity[] = ['quiet', 'normal', 'verbose', 'trace'];

/** Runs the fixture repository's `ticket-to-pr` on `FAKE-1`, and leaves the run directory in `outDir`. */
export async function generateGoldenRun(_outDir: string): Promise<void> {}

/** What `events` print at `verbosity`, in plain mode. */
export function renderView(_events: readonly SailEvent[], _verbosity: Verbosity, _runsDir?: string): string {
  return '';
}

// Opens a seeded run: a new run whose journal starts with another run's calls. TDD stub (TASK-005): it refuses
// everything.
import type { ResolvedAdapters } from './adapters';
import type { Clock } from './clock';
import type { OpenedRun } from './open-run';

export interface SeededRunOptions {
  /** Where the run starts from: `.sail/` is found from here up to the git root, and the source run beside it. */
  cwd: string;
  /** The id of the run whose calls are reused. */
  fromRun: string;
  /** The stage that runs: every call the source made before its first call is reused. */
  stage: string;
  /** Runs the rest of the workflow after the stage. Left out, the run stops after the stage's first call. */
  continue?: boolean;
  /** The four adapters, resolved from the config before anything else. */
  adapters: ResolvedAdapters;
  /** The run's clock, read once on entry for the run id's time and the header's `startedAt`. */
  clock?: Clock;
  /** Fills the run id's random part. */
  random?: (bytes: Uint8Array) => Uint8Array;
  /** Refuses the run when it has aborted by the time the run would be opened. */
  signal?: AbortSignal;
}

/** Opens a run seeded with `fromRun`'s calls before `stage`, or says why it can't, having written nothing. */
export async function openSeededRun(_options: SeededRunOptions): Promise<OpenedRun | { refused: string }> {
  return { refused: 'TDD stub (TASK-005): openSeededRun() is not written yet' };
}

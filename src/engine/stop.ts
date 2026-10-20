// `stopRun()`: the engine side of `sail stop <run>`. Stub: every stop is refused.
import type { ResolvedAdapters } from './adapters';
import type { Clock } from './clock';
import type { RunEnd } from './runtime';

export interface StopRunOptions {
  /** The `.sail/` the run belongs to: the run is found beside it. */
  sailDir: string;
  runId: string;
  /** The Workspace port, which holds the run's lease and workspace. */
  adapters: ResolvedAdapters<'workspace'>;
  /** What `run:end` is stamped with. The system's by default. */
  clock?: Clock;
}

/** How a stop went: the run ended now, a running run was asked to stop, or the stop was refused. */
export type Stopped = { ended: RunEnd } | { requested: { pid: number } } | { refused: string };

export async function stopRun(_options: StopRunOptions): Promise<Stopped> {
  return { refused: '' };
}

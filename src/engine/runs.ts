// The runs in `.sail-runs/`: every one listed, and one found by its id or a prefix of it.
import type { RunStatus } from './run-dir';

/** One run as `sail runs` lists it. A field whose file can't be read is left out, and `problem` says why. */
export interface RunListing {
  runId: string;
  dir: string;
  workflow?: string;
  startedAt?: string;
  status?: RunStatus;
  problem?: string;
}

/** Every run beside `sailDir`, oldest first. */
export function listRuns(_sailDir: string): RunListing[] {
  return [];
}

/** The run `name` names: its exact id, or a prefix only one run's id starts with. */
export function resolveRun(_sailDir: string, _name: string): { runId: string; dir: string } | { refused: string } {
  return { refused: 'resolveRun is not written yet' };
}

// A run's directory, `.sail-runs/<ticket key>-<ulid>/` beside `.sail/`, and its STATUS file, which holds the run's
// status and, for a failed or suspended run, its stop reason. The run id's ticket key comes from the run's source,
// which until intake exists is the LOCAL stub.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createDir, replaceFile } from './durable';

export const RUNS_DIR = '.sail-runs';

/** Where runs live: beside `sailDir`, in the directory that holds it. `sail stage run` writes there too. */
export function runsDir(sailDir: string): string {
  return join(dirname(sailDir), RUNS_DIR);
}

/** What a run was started from: the run header's `source`. Intake resolves it into the run's input. */
export interface Source {
  kind: 'ticket';
  ticketKey: string;
  via: 'cli' | 'watch';
  forced: boolean;
}

/** A run started by hand with no ticket. It stands in until intake exists, so its runs are `LOCAL-<ulid>`. */
export const LOCAL_SOURCE: Source = { kind: 'ticket', ticketKey: 'LOCAL', via: 'cli', forced: false };

/**
 * Creates the directory of run `runId` and returns its absolute path, creating `.sail-runs/` on first use. Both entries
 * are synced, or a crash could lose the first run whole. A run directory is created once, so an existing one throws
 * `EEXIST`.
 */
export function createRunDir(sailDir: string, runId: string): string {
  const runs = runsDir(sailDir);
  createDir(runs, true);
  const dir = join(runs, runId);
  createDir(dir);
  return dir;
}

const STATUSES = ['running', 'suspended', 'completed', 'failed'] as const;
export type Status = (typeof STATUSES)[number];

/** Why a failed or suspended run ended without completing, in `sail.summary.v1`'s order. */
export const STOP_REASONS = [
  'workflow_failed',
  'stage_error',
  'budget_exceeded',
  'determinism_violation',
  'until',
  'unwatched',
  'stopped',
] as const;
export type StopReason = (typeof STOP_REASONS)[number];

/** What `STATUS` holds: a failed or suspended run carries exactly one stop reason, and any other run none. */
export interface RunStatus {
  status: Status;
  stopReason?: StopReason;
}

const STATUS_FILE = 'STATUS';

/** Why `status` can't carry `stopReason`, or undefined when the pairing is allowed. */
function pairingProblem(status: Status, stopReason: StopReason | undefined): string | undefined {
  const stops = status === 'failed' || status === 'suspended';
  if (stops && stopReason === undefined) return `a ${status} run carries exactly one stop reason`;
  if (!stops && stopReason !== undefined) return `a ${status} run carries no stop reason, not ${stopReason}`;
  return undefined;
}

/**
 * Sets the run's status, replacing `STATUS` atomically so a reader never sees half of it. The file holds
 * `<status>\n`, or `<status> <stop reason>\n` for a failed or suspended run. A pairing that breaks that rule throws,
 * writing nothing.
 */
export function writeStatus(runDir: string, status: Status, stopReason?: StopReason): void {
  const problem = pairingProblem(status, stopReason);
  if (problem !== undefined) throw new Error(`can't write STATUS ${status}: ${problem}`);
  replaceFile(join(runDir, STATUS_FILE), stopReason === undefined ? `${status}\n` : `${status} ${stopReason}\n`);
}

/**
 * The run's status and stop reason. `STATUS` holding anything but one status, then a stop reason exactly when the
 * status is failed or suspended, then a newline, throws naming the file.
 */
export function readStatus(runDir: string): RunStatus {
  const path = join(runDir, STATUS_FILE);
  const text = readFileSync(path, 'utf8');
  const [status, stopReason, ...rest] = text.endsWith('\n') ? text.slice(0, -1).split(' ') : [];
  const known = STATUSES.find((each) => each === status);
  const reason = STOP_REASONS.find((each) => each === stopReason);
  if (
    known === undefined ||
    rest.length > 0 ||
    (stopReason !== undefined && reason === undefined) ||
    pairingProblem(known, reason) !== undefined
  ) {
    throw new Error(
      `${path} holds ${JSON.stringify(text)}, not one of ${STATUSES.join(', ')}, a stop reason for failed or suspended, and a newline`,
    );
  }
  return reason === undefined ? { status: known } : { status: known, stopReason: reason };
}

// A run's directory, `.sail-runs/<ticket key>-<ulid>/` beside `.sail/`, and its STATUS file. The run id's ticket key
// comes from the run's source, which until intake exists is the LOCAL stub.
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

const STATUS_FILE = 'STATUS';

/**
 * Sets the run's status, replacing `STATUS` atomically so a reader never sees half of it. The file holds only the
 * status and a newline: phase 3.2 decides how a stop reason travels with it.
 */
export function writeStatus(runDir: string, status: Status): void {
  replaceFile(join(runDir, STATUS_FILE), `${status}\n`);
}

/** The run's status. `STATUS` holding anything but one status and a newline throws, naming the file. */
export function readStatus(runDir: string): Status {
  const path = join(runDir, STATUS_FILE);
  const text = readFileSync(path, 'utf8');
  const status = STATUSES.find((each) => text === `${each}\n`);
  if (status === undefined) {
    throw new Error(`${path} holds ${JSON.stringify(text)}, not one of ${STATUSES.join(', ')} and a newline`);
  }
  return status;
}

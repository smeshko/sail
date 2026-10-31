// A run's directory, `.sail-runs/<ticket key>-<ulid>/` beside `.sail/`, and its STATUS file, which holds the run's
// status and, for a failed or suspended run, its stop reason. The run id's ticket key comes from the run's source.
//
// A run also keeps `definition/`: a copy of the clone's whole `.sail/` and the conventions its prompts read, each at its
// path from the repository root, made as the run starts. A call reads its stage's prompt, templates and scripts from the
// copy, and the run reads `.sail/lib/`, the shared prompt fragments and `$SAIL_CONFIG` from it too, so a workflow edited
// in the checkout mid-run changes nothing the run does, and a resume loads the run's workflow, config and adapters from
// the copy as well. Restart is how a run picks up an edit. A script's command is still recorded at its checkout path.
// The stage folders are what `workflow.sha256` hashes, so the copy is what the header vouches for.
//
// A run started from committed definitions, as a dispatched one is, copies the committed `.sail/` and conventions;
// any other start copies the clone's working tree. A layout-2 run kept the whole copy only when it was dispatched.
import { cpSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { basename, dirname, join, relative, sep } from 'node:path';
import { createDir, replaceFile } from './durable';

export const RUNS_DIR = '.sail-runs';

/**
 * The run directory layout a run's header marks: each call's records sit beside its `$STAGE_OUT`, `out/` (layout 2), and
 * `definition/` holds the whole `.sail/` (layout 3).
 */
export const RUN_LAYOUT = 3;

/**
 * Why a run whose header is `header` can't be resumed or seed a run, or undefined when it is marked with the layout.
 * A run without the mark kept each call's records inside its `$STAGE_OUT`.
 */
export function unmarkedRefusal(
  runId: string,
  header: { layout?: number },
  what: 'be resumed' | 'seed a run',
): string | undefined {
  if (header.layout !== undefined) return undefined;
  const stop = what === 'be resumed' ? `. sail stop ${runId} ends it` : '';
  return `run ${runId} keeps its calls' records inside their $STAGE_OUT, as runs did before sail moved them to out/: it can't ${what}${stop}`;
}

/** Whether a run whose header is `header` keeps the whole `.sail/` in `definition/`, and so resumes from it. */
export function resumesFromCopy(header: { layout?: number; definitionsSha?: string }): boolean {
  return header.layout === RUN_LAYOUT || header.definitionsSha !== undefined;
}

/** Why a run whose header is `header` can't be resumed for want of a whole copy of `.sail/`, or undefined when it has one. */
export function uncopiedRefusal(
  runId: string,
  header: { layout?: number; definitionsSha?: string },
): string | undefined {
  if (resumesFromCopy(header)) return undefined;
  return `run ${runId} started before runs kept their whole .sail/ in definition/: it can't be resumed. sail stop ${runId} ends it, and sail run --from-run ${runId} --stage <stage> --continue restarts it`;
}

/** Where runs live: beside `sailDir`, in the directory that holds it. `sail stage run` writes there too. */
export function runsDir(sailDir: string): string {
  return join(dirname(sailDir), RUNS_DIR);
}

/** The checks `--force` can override, in the order a run header lists them. */
export const FORCED = ['designation', 'state', 'cap'] as const;
export type Forced = (typeof FORCED)[number];

/** A run started from a ticket, by its key. */
export interface TicketRunSource {
  kind: 'ticket';
  ticketKey: string;
  via: 'cli' | 'watch';
  /**
   * The checks `--force` overrode, each at most once: `designation` when the ticket didn't carry the repository's
   * label, `state` when the claim didn't take because the ticket was not in a pick-up state, `cap` when its workflow's
   * live runs filled its maxConcurrentRuns. Empty for a run nobody forced, and for one `--force` had nothing to override.
   */
  forced: Forced[];
}

/** A run started from a pull request, by its number, at the head sha it was resolved at. */
export interface PullRequestRunSource {
  kind: 'pr';
  number: number;
  /** The full sha the run is for: its workspace starts there. */
  headSha: string;
  via: 'cli' | 'watch';
  /**
   * The checks `--force` overrode: `designation` when the pull request didn't carry the label, `state` when it was
   * closed, merged or a draft, `cap` when its workflow's live runs filled its maxConcurrentRuns.
   */
  forced: Forced[];
}

/** What a run was started from: the run header's `source`. Intake resolves it into the run's input. */
export type Source = TicketRunSource | PullRequestRunSource;

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

/**
 * What a run being opened is, before its header is written: its workflow, and the branch it leased on its remote. The
 * cap counts a run by it while the run makes its workspace, which can take minutes, and it goes once STATUS is written.
 */
export interface Opening {
  workflow: string;
  branch: string;
  remote: string;
}

const OPENING_FILE = 'OPENING';

/** Writes the run's `OPENING`. */
export function writeOpening(runDir: string, opening: Opening): void {
  replaceFile(join(runDir, OPENING_FILE), `${JSON.stringify(opening)}\n`);
}

/** The run's `OPENING`, or undefined when it has none or it doesn't read as one. */
export function readOpening(runDir: string): Opening | undefined {
  try {
    const read: unknown = JSON.parse(readFileSync(join(runDir, OPENING_FILE), 'utf8'));
    if (typeof read !== 'object' || read === null) return undefined;
    const { workflow, branch, remote } = read as Record<string, unknown>;
    if (typeof workflow !== 'string' || typeof branch !== 'string' || typeof remote !== 'string') return undefined;
    return { workflow, branch, remote };
  } catch {
    return undefined;
  }
}

/** Removes the run's `OPENING`, once its header and STATUS say what it is. */
export function removeOpening(runDir: string): void {
  rmSync(join(runDir, OPENING_FILE), { force: true });
}

/** The folder of a run directory that holds its copy of the whole `.sail/` and the conventions. */
export const DEFINITION_DIR = 'definition';

/** The path from the repository root an origin names, or undefined for one that isn't the repository's. */
const repoPath = (origin: string | undefined) =>
  origin?.startsWith('repo:') ? origin.slice('repo:'.length) : undefined;

/** The intake's `intake.ts` as a roster origin says: a private intake's origin is the file, a shared one's its folder. */
const intakeFolder = (path: string): string => (path.endsWith('.ts') ? dirname(path) : path);

/**
 * Copies `sailDir`, the clone's `.sail/`, without its `node_modules`, and each of `conventions` that exists under `root`
 * into `runDir`'s definition, each at its path from `root`. Symlinks under `.sail/` are copied as they are; a
 * convention is copied as what it reads, since a symlink to a file outside the copy would dangle there.
 */
export function copyDefinitions(runDir: string, root: string, sailDir: string, conventions: string[]): void {
  const definition = join(runDir, DEFINITION_DIR);
  cpSync(sailDir, join(definition, relative(root, sailDir)), {
    recursive: true,
    verbatimSymlinks: true,
    filter: (source) => basename(source) !== 'node_modules',
  });
  for (const path of conventions) {
    if (existsSync(join(root, path))) {
      cpSync(join(root, path), join(definition, path), { recursive: true, dereference: true });
    }
  }
}

/**
 * The stage file a call of the stage whose roster origin is `origin` reads its folder beside: the run's copy, or `live`,
 * the checkout's, for a stage of no copy: a layout-2 run's, which a resume refuses.
 */
export function copiedStageFile(runDir: string, origin: string | undefined, live: string): string {
  const path = repoPath(origin);
  const copy = path === undefined ? undefined : join(runDir, DEFINITION_DIR, path);
  return copy !== undefined && existsSync(copy) ? join(copy, 'stage.ts') : live;
}

/**
 * The file an intake's steps read their folder beside: the run's copy of the intake's folder, or `live`, the
 * checkout's, for an intake of no copy: a built-in, or a layout-2 run's, which a resume refuses.
 */
export function copiedIntakeFile(runDir: string, origin: string | undefined, live: string): string {
  const path = repoPath(origin);
  if (path === undefined) return live;
  const folder = join(runDir, DEFINITION_DIR, intakeFolder(path));
  return existsSync(folder) ? join(folder, basename(live)) : live;
}

/**
 * `path` relative to `root`, as a run records it. A file of `runDir`'s copy is recorded at the path it was copied from,
 * so a script's command reads as the stage's file, whichever copy ran it.
 */
export function checkoutPath(root: string, runDir: string, path: string): string {
  const copied = relative(join(runDir, DEFINITION_DIR), path);
  return copied.startsWith(`..${sep}`) || copied === '..' ? relative(root, path) || '.' : copied;
}

/**
 * Removes the run directory `dir` and all it holds. Only a refused start does this, to undo the directory it made
 * before anything was written to it but the workspace, which is released first.
 */
export function removeRunDir(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
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
  'interrupted',
  'usage_limit',
  'port_unavailable',
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

// What the dashboard reads, and the one place it builds a path: repositories from the watcher registry, each one's
// runs, and a call's files. Every path comes from a registry entry, never from a request, and every file is checked by
// realpath to lie inside its run directory, so a name with `..`, an encoded separator, a symlink a step left, or an
// edited `events.ndjson` can't lead out. Nothing here writes.
import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { isPlainName } from '../engine/call-dir';
import { runsDir, type Source } from '../engine/run-dir';
import { RUN_HEADER_FILE, readRunHeader } from '../engine/run-header';
import { listRuns, type RunListing } from '../engine/runs';
import { validateDocument } from '../engine/schemas';
import { EVENTS_FILE, readEvents } from '../events/consumers/ndjson';
import type { Summary } from '../events/summary';
import { type RegistryEntry, type RegistryProblem, readRegistry } from '../watch/registry';
import { containedFile, inside } from './contained';
import { type QueueView, queueViews } from './queues';

export { containedFile, inside };

/** A registered repository, with `problem` when its `.sail/` is gone. */
export type Repo = RegistryEntry & { problem?: string };

/** One run as the dashboard lists it: `sail runs`' listing, its source, and its summary or null. */
export type RunItem = Omit<RunListing, 'dir'> & { source?: Source; summary: Summary | null };

/** A repository with its runs and its queues: what the index stream sends. */
export type IndexRepo = Repo & { runs: RunItem[]; queues: QueueView[] };

/** The files of a call the dashboard serves. */
export const CALL_FILES = ['result.json', 'session.log', 'stdout.log', 'stderr.log'] as const;
export type CallFileName = (typeof CALL_FILES)[number];

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Why the run's file `name` isn't a regular file of its own, or undefined. One not written yet is fine. */
function ownFileProblem(runDir: string, name: string): string | undefined {
  const path = join(runDir, name);
  try {
    lstatSync(path);
  } catch {
    return undefined;
  }
  return containedFile(runDir, path) === undefined ? `${name} is not a file of this run` : undefined;
}

/** Why the run's `events.ndjson` isn't a regular file of its own, or undefined. */
export function eventsProblem(runDir: string): string | undefined {
  return ownFileProblem(runDir, EVENTS_FILE);
}

/** Why a follow can't read the run: its `events.ndjson` or its `STATUS` isn't a regular file of its own. */
export function followProblem(runDir: string): string | undefined {
  return eventsProblem(runDir) ?? ownFileProblem(runDir, STATUS_FILE);
}

/** Every registered repository, each with `problem` when its `.sail/` no longer exists, and the registry's problems. */
export function repos(registryDir: string): { repos: Repo[]; problems: RegistryProblem[] } {
  const { entries, problems } = readRegistry(registryDir);
  return {
    repos: entries.map((entry) =>
      existsSync(entry.sailDir) ? entry : { ...entry, problem: `${entry.sailDir} no longer exists` },
    ),
    problems,
  };
}

/** The valid entry registered as `name`. */
export function findRepo(registryDir: string, name: string): RegistryEntry | undefined {
  return readRegistry(registryDir).entries.find((entry) => entry.name === name);
}

const STATUS_FILE = 'STATUS';

/** The files a listing reads from a run. */
const LISTED_FILES = [RUN_HEADER_FILE, STATUS_FILE, 'summary.json'];

/** Which of the files a listing reads aren't the run's own regular files, or undefined when all are. */
function strayFiles(dir: string): string | undefined {
  const stray = LISTED_FILES.filter((name) => {
    try {
      lstatSync(join(dir, name));
    } catch {
      return false;
    }
    return containedFile(dir, join(dir, name)) === undefined;
  });
  return stray.length === 0 ? undefined : `${stray.join(', ')}: not a file of this run, so nothing of it is read`;
}

/**
 * The repository's runs in `listRuns()` order, each with its header's source and its parsed `summary.json`. A run whose
 * `run.json`, `STATUS` or `summary.json` links out of it, or isn't a regular file, is listed by id and problem alone.
 */
export function runItems(entry: RegistryEntry): RunItem[] {
  if (!existsSync(entry.sailDir)) return [];
  const refused = new Set<string>();
  const refuse = (dir: string) => {
    const problem = strayFiles(dir);
    if (problem !== undefined) refused.add(dir);
    return problem;
  };
  return listRuns(entry.sailDir, refuse).map(({ dir, ...listed }) => {
    const item: RunItem = { ...listed, summary: null };
    if (refused.has(dir)) return item;
    const problems = listed.problem === undefined ? [] : [listed.problem];
    try {
      item.source = readRunHeader(dir).source;
    } catch {
      // listRuns() has already said why the header can't be read.
    }
    const summary = join(dir, 'summary.json');
    if (existsSync(summary)) {
      try {
        const data: unknown = JSON.parse(readFileSync(summary, 'utf8'));
        // The page reads a summary by its shape, so one that isn't a `sail.summary.v1` is not passed on (review R1-1).
        const issues = validateDocument('sail.summary.v1', data);
        if (issues.length === 0) item.summary = data as Summary;
        else {
          const first = issues[0];
          problems.push(`summary.json is not a sail.summary.v1: ${first?.path ?? ''} ${first?.message ?? ''}`.trim());
        }
      } catch (error) {
        problems.push(`${summary} can't be read: ${messageOf(error)}`);
      }
    }
    if (problems.length > 0) item.problem = problems.join('; ');
    return item;
  });
}

/**
 * Every repository with its runs and its queues. A repository whose runs can't be listed has none, nor any queue, and
 * a problem that says why.
 */
export function index(registryDir: string): IndexRepo[] {
  return repos(registryDir).repos.map((repo) => {
    try {
      return { ...repo, runs: runItems(repo), queues: queueViews(repo) };
    } catch (error) {
      return { ...repo, runs: [], queues: [], problem: `its runs can't be listed: ${messageOf(error)}` };
    }
  });
}

/** The directory of run `runId` in the repository, or why there is none. */
export function findRunDir(entry: RegistryEntry, runId: string): string | { missing: string } {
  const missing = { missing: `no run '${runId}' in ${entry.name}` };
  if (!isPlainName(runId)) return missing;
  const runs = runsDir(entry.sailDir);
  const dir = join(runs, runId);
  if (!existsSync(join(dir, RUN_HEADER_FILE)) || !inside(runs, dir)) return missing;
  return dir;
}

const CALL_ENDS = new Set(['intake:end', 'stage:end', 'step:end']);
const CALL_STARTS = new Set(['intake:start', 'stage:start', 'step:start']);

/**
 * File `name` of a call's try that has started and not ended: `NN-<stage>/call-<n>/`, or `try-<t>/` below it for a later
 * try. For a step key `stage#n/step` it is `call-<n>/steps/<index>-<step>/`, with the `index` its `step:start` named.
 * No end points at it yet, so the directory is found from the key, by the layout src/engine/call-dir.ts writes.
 */
function runningFile(
  runDir: string,
  key: string,
  tryNumber: number,
  index: number | undefined,
  name: string,
): string | undefined {
  const match = /^([^#/]+)#([1-9][0-9]*)(?:\/([^/]+))?$/.exec(key);
  if (match === null) return undefined;
  const [, stage, call, step] = match;
  if (step !== undefined && (index === undefined || !isPlainName(step))) return undefined;
  const stageDir = readdirSync(runDir).find(
    (entry) => /^[0-9]{2,}-/.test(entry) && entry.replace(/^[0-9]+-/, '') === stage,
  );
  if (stageDir === undefined) return undefined;
  const tries = tryNumber > 1 ? [`try-${tryNumber}`] : [];
  const where = step === undefined ? [`call-${call}`] : [`call-${call}`, 'steps', `${index}-${step}`];
  const file = join(runDir, stageDir, ...where, ...tries, name);
  return inside(runDir, file) ? file : undefined;
}

/** Whether `resultPath` is a run-relative path to a `result.json`, with no way up. */
function plainResultPath(resultPath: string): boolean {
  if (isAbsolute(resultPath) || !resultPath.endsWith('/result.json')) return false;
  return resultPath.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..');
}

/**
 * File `name` of the call or step `key`, found beside the `result.json` the last `intake:end`, `stage:end` or `step:end`
 * with that key points at. One whose last `intake:start`, `stage:start` or `step:start` came after that end is running,
 * and its file is the running try's (review R3-2). It must exist and lie inside the run directory.
 */
export function callFile(runDir: string, key: string, name: string): string | { missing: string } {
  const missing = { missing: `no ${name} for '${key}'` };
  if (!(CALL_FILES as readonly string[]).includes(name)) return missing;
  const unread = eventsProblem(runDir);
  if (unread !== undefined) return { missing: unread };
  let resultPath: string | undefined;
  let running: { tryNumber: number; index?: number } | undefined;
  try {
    for (const event of readEvents(runDir)) {
      const fields = event as { key?: unknown; resultPath?: unknown; try?: unknown; index?: unknown };
      if (fields.key !== key) continue;
      if (CALL_ENDS.has(event.type) && typeof fields.resultPath === 'string') {
        resultPath = fields.resultPath;
        running = undefined;
      } else if (CALL_STARTS.has(event.type)) {
        const tryNumber = typeof fields.try === 'number' && Number.isInteger(fields.try) ? fields.try : 1;
        const index = event.type === 'step:start' ? fields.index : undefined;
        running = {
          tryNumber,
          ...(typeof index === 'number' && Number.isInteger(index) && index >= 1 ? { index } : {}),
        };
      }
    }
  } catch (error) {
    return { missing: `the events of this run can't be read: ${messageOf(error)}` };
  }
  if (running !== undefined) return runningFile(runDir, key, running.tryNumber, running.index, name) ?? missing;
  if (resultPath === undefined || !plainResultPath(resultPath)) return missing;
  const file = join(runDir, dirname(resultPath), name);
  return inside(runDir, file) ? file : missing;
}

// What the dashboard reads, and the one place it builds a path: repositories from the watcher registry, each one's
// runs, and a call's files. Every path comes from a registry entry, never from a request, and every file is checked by
// realpath to lie inside its run directory, so a name with `..`, an encoded separator, a symlink a step left, or an
// edited `events.ndjson` can't lead out. Nothing here writes.
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, sep } from 'node:path';
import { isPlainName } from '../engine/call-dir';
import { runsDir, type Source } from '../engine/run-dir';
import { RUN_HEADER_FILE, readRunHeader } from '../engine/run-header';
import { listRuns, type RunListing } from '../engine/runs';
import { readEvents } from '../events/consumers/ndjson';
import type { Summary } from '../events/summary';
import { type RegistryEntry, type RegistryProblem, readRegistry } from '../watch/registry';

/** A registered repository, with `problem` when its `.sail/` is gone. */
export type Repo = RegistryEntry & { problem?: string };

/** One run as the dashboard lists it: `sail runs`' listing, its source, and its summary or null. */
export type RunItem = Omit<RunListing, 'dir'> & { source?: Source; summary: Summary | null };

/** A repository with its runs: what the index stream sends. */
export type IndexRepo = Repo & { runs: RunItem[] };

/** The files of a call the dashboard serves. */
export const CALL_FILES = ['result.json', 'session.log', 'stdout.log', 'stderr.log'] as const;
export type CallFileName = (typeof CALL_FILES)[number];

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Whether `path` lies inside `dir`, both resolved through every symlink. A path that doesn't exist doesn't. */
export function inside(dir: string, path: string): boolean {
  try {
    const root = realpathSync(dir);
    const real = realpathSync(path);
    return real.startsWith(`${root}${sep}`);
  } catch {
    return false;
  }
}

/**
 * The real path of `path` when it is a regular file inside `dir`, both resolved through every symlink, or undefined. A
 * FIFO, a device or a directory a step left isn't one, so reading it can't block or fail.
 */
export function containedFile(dir: string, path: string): string | undefined {
  try {
    const real = realpathSync(path);
    return real.startsWith(`${realpathSync(dir)}${sep}`) && statSync(real).isFile() ? real : undefined;
  } catch {
    return undefined;
  }
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

/** The repository's runs in `listRuns()` order, each with its header's source and its parsed `summary.json`. */
export function runItems(entry: RegistryEntry): RunItem[] {
  if (!existsSync(entry.sailDir)) return [];
  return listRuns(entry.sailDir).map(({ dir, ...listed }) => {
    const item: RunItem = { ...listed, summary: null };
    const problems = listed.problem === undefined ? [] : [listed.problem];
    try {
      item.source = readRunHeader(dir).source;
    } catch {
      // listRuns() has already said why the header can't be read.
    }
    const summary = join(dir, 'summary.json');
    if (existsSync(summary)) {
      try {
        item.summary = JSON.parse(readFileSync(summary, 'utf8')) as Summary;
      } catch (error) {
        problems.push(`${summary} can't be read: ${messageOf(error)}`);
      }
    }
    if (problems.length > 0) item.problem = problems.join('; ');
    return item;
  });
}

/** Every repository with its runs. */
export function index(registryDir: string): IndexRepo[] {
  return repos(registryDir).repos.map((repo) => ({ ...repo, runs: runItems(repo) }));
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

/** Whether `resultPath` is a run-relative path to a `result.json`, with no way up. */
function plainResultPath(resultPath: string): boolean {
  if (isAbsolute(resultPath) || !resultPath.endsWith('/result.json')) return false;
  return resultPath.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..');
}

/**
 * File `name` of the call `key`, found beside the `result.json` the last `intake:end`, `stage:end` or `step:end` with
 * that key points at. It must exist and lie inside the run directory.
 */
export function callFile(runDir: string, key: string, name: string): string | { missing: string } {
  const missing = { missing: `no ${name} for '${key}'` };
  if (!(CALL_FILES as readonly string[]).includes(name)) return missing;
  let resultPath: string | undefined;
  try {
    for (const event of readEvents(runDir)) {
      const fields = event as { key?: unknown; resultPath?: unknown };
      if (CALL_ENDS.has(event.type) && fields.key === key && typeof fields.resultPath === 'string') {
        resultPath = fields.resultPath;
      }
    }
  } catch (error) {
    return { missing: `the events of this run can't be read: ${messageOf(error)}` };
  }
  if (resultPath === undefined || !plainResultPath(resultPath)) return missing;
  const file = join(runDir, dirname(resultPath), name);
  return inside(runDir, file) ? file : missing;
}

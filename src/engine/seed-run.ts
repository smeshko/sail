// Opens a seeded run: a new run whose journal starts with another run's calls, those before a named stage, so a prompt
// can be iterated on without paying for the calls before it. The runtime then drives it as it drives any run: the
// intake is taken from the journal's head, the replay returns each reused call from its line, and the stage's first
// call is the first one that runs.
//
// In order, every refusal before anything is written:
//   1. `.sail/` and its config, then the claim of `.sail/` for the process;
//   2. the source run: a plain name, a directory and no link, with a `run.json` that reads, from a run that had a
//      workspace and the layout mark. Any STATUS is accepted, a crashed `running` one included, since only its journal's complete lines
//      are read;
//   3. the workflow as it reads now, its model aliases, and no stage named `intake`;
//   4. the stage, which must be a stage of that workflow;
//   5. the source's journal, which must read: an `intake#1` that passed, and a call of the stage. The seed is every
//      entry before the stage's first call, or before the first line of any of its group's calls, their steps' lines
//      included: a seed never splits a group, so the seeded run runs the whole group again. A stage with only step lines
//      and no recorded group is refused if another call is incomplete too: they may be grouped. Each entry must point inside its own
//      call directory, at regular files, since that is what a run writes and all the copy takes.
// Then the run id is minted and the header built and checked, with `fromRun` and no claim: a seeded run reads no
// ticket and claims nothing: the source's ticket, as its events name it, is carried for the summary. An abort seen by
// then refuses. Then, as a start does, the branch is leased and the run directory and the workspace made, each undone
// on a refusal. The branch is the source's, suffixed `-seeded-<the run id's last 8 characters>`, so a seeded run
// blocks neither its source nor another seeded run.
//
// The reused calls' directories are copied from the source, every try included, so the journal's paths hold in the new
// run directory and the consumed files keep their bytes. A copy that fails undoes the workspace, the run directory and
// the lease, and is thrown on: it is a bug or a disk fault, not a refusal. Then `run.json`, the journal holding the
// seed, the events file and STATUS `running` are written.
//
// The workspace starts at the source's base: the source's code changes are not carried. A reused call's commits are not
// in the seeded workspace, so a later stage that consumes a gitDiff sees only what the seeded run changed. Its workspace
// setup runs as any run's does, so what the setup installed in the source's workspace is there again.
import { cpSync, existsSync, lstatSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { createEventsFile, readEvents } from '../events/consumers/ndjson';
import { summarize } from '../events/summary';
import type { ProviderEvent } from '../events/types';
import type { RunRef } from '../ports/workspace';
import type { ResolvedAdapters } from './adapters';
import { isPlainName } from './call-dir';
import { type Clock, systemClock } from './clock';
import { INTAKE_KEY } from './intake';
import { appendJournal, createJournal, type JournalEntry, readJournal } from './journal';
import { loadWorkflow } from './load-workflow';
import {
  claim,
  collecting,
  findConfigured,
  intakeNameTaken,
  type OpenedRun,
  resolveNamed,
  startWorkspace,
  undoOpened,
} from './open-run';
import { credentialValues, redactor } from './redact';
import { harnessesReached, modelProblems } from './roster';
import { copyStageFolders, runsDir, type Source, unmarkedRefusal, writeStatus } from './run-dir';
import {
  assertRunHeader,
  buildRunHeader,
  RUN_HEADER_FILE,
  type RunHeader,
  readRunHeader,
  workspaceFields,
  writeRunHeader,
} from './run-header';
import { newRunId } from './run-id';

export interface SeededRunOptions {
  secrets?: readonly string[];
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

/** Why `error`, thrown by a reader of the source run, happened: its message. */
const why = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** The source run's directory and header, or why it can't seed a run. */
function findSource(sailDir: string, runId: string): { dir: string; header: RunHeader } | { refused: string } {
  if (!isPlainName(runId)) return { refused: `'${runId}' is not a run id` };
  const runs = runsDir(sailDir);
  const dir = join(runs, runId);
  if (!existsSync(join(dir, RUN_HEADER_FILE))) {
    return { refused: `no run '${runId}' in ${relative(dirname(sailDir), runs)}` };
  }
  // A run directory sail made is a directory: a link would copy from wherever it leads.
  if (lstatSync(dir).isSymbolicLink()) {
    return {
      refused: `run ${runId} is a symlink in ${relative(dirname(sailDir), runs)}, not a run directory: it can't seed a run`,
    };
  }
  try {
    return { dir, header: readRunHeader(dir) };
  } catch (error) {
    return { refused: `run ${runId}'s run.json can't be read: ${why(error)}` };
  }
}

const CALL_DIR = /^\d{2,}-[^/]+\/call-\d+$/;

/** The call directory of a run-relative path, `NN-<stage>/call-N`, when the path lies inside one. */
function callDirOf(path: string): string | undefined {
  const segments = path.split('/');
  if (segments.length < 3 || !segments.every(isPlainName)) return undefined;
  const dir = segments.slice(0, 2).join('/');
  return CALL_DIR.test(dir) ? dir : undefined;
}

/**
 * The first step of the run-relative `path` that isn't what a run wrote there, with what it is instead, or undefined:
 * each directory on the way must be a directory, and the path itself a regular file, none of them a link.
 */
function strayOn(sourceDir: string, path: string): { path: string; is: string } | undefined {
  const segments = path.split('/');
  for (let at = 1; at <= segments.length; at++) {
    const step = segments.slice(0, at).join('/');
    const stat = lstatSync(join(sourceDir, step), { throwIfNoEntry: false });
    const leaf = at === segments.length;
    if (leaf ? stat?.isFile() : stat?.isDirectory()) continue;
    if (stat === undefined) return { path: step, is: 'missing' };
    return { path: step, is: stat.isSymbolicLink() ? 'a symlink' : `not a ${leaf ? 'regular file' : 'directory'}` };
  }
  return undefined;
}

/**
 * The call directories of `entries`, each once, in order, or why the seed can't trust them. Each entry's result and
 * files must lie in its own call directory, `NN-<stage>/call-N`, which holds every try, and be a regular file reached
 * through directories alone: they are what the new run reads, and a step can't produce a link, so one there was put in
 * after the run and could lead anywhere. Anything else in a call directory is copied as it is, a link as a link: an
 * agent's rejected try may have left one, and nothing reads it again.
 */
function callDirs(sourceDir: string, runId: string, entries: readonly JournalEntry[]): string[] | { refused: string } {
  const dirs = new Set<string>();
  for (const entry of entries) {
    const dir = callDirOf(entry.resultPath);
    const paths = [entry.resultPath, ...Object.values(entry.files)];
    for (const path of paths) {
      if (dir === undefined || callDirOf(path) !== dir) {
        return { refused: `run ${runId}'s journal line ${entry.seq} points at '${path}', outside a call directory` };
      }
    }
    for (const path of paths) {
      const stray = strayOn(sourceDir, path);
      if (stray !== undefined) {
        return { refused: `run ${runId}'s ${stray.path} is ${stray.is}: a seed copies only what the run wrote` };
      }
    }
    dirs.add(dir as string);
  }
  return [...dirs];
}

/**
 * The seed's cut before stage's first call or any line of its group. Step lines carry no group, so read the group
 * from call lines, then include every member's step lines when finding its start. No line of stage means -1.
 * With only steps and no group-bearing call, refuse if another call is incomplete too: they may be grouped.
 * A lone incomplete call is safe: the cut excludes all its steps, and no other incomplete call can be reused.
 */
function seedEnd(entries: readonly JournalEntry[], stage: string): number | { incomplete: string } {
  const first = entries.findIndex((entry) => entry.stage === stage);
  if (first === -1) return -1;
  const own = `${stage}#${entries[first]?.call}`;
  const group = entries.find((entry) => entry.step === undefined && entry.group?.includes(own))?.group;
  if (group === undefined) {
    const completed = new Set(entries.filter((entry) => entry.step === undefined).map((entry) => entry.key));
    if (
      !completed.has(own) &&
      entries.some((entry) => {
        const call = `${entry.stage}#${entry.call}`;
        return call !== own && !completed.has(call);
      })
    ) {
      return { incomplete: own };
    }
    return first;
  }
  const members = new Set(group);
  return entries.findIndex((entry) => members.has(`${entry.stage}#${entry.call}`));
}

/**
 * Opens a run seeded with `fromRun`'s calls before `stage`, or says why it can't, having written nothing. The run stops
 * after the stage's first call unless `continue`.
 */
export async function openSeededRun(options: SeededRunOptions): Promise<OpenedRun | { refused: string }> {
  const { cwd, fromRun, stage } = options;
  const now = (options.clock ?? systemClock)();
  const found = findConfigured(cwd);
  if ('refused' in found) return found;
  const { config } = found;
  claim(found.dir);
  const source = findSource(found.dir, fromRun);
  if ('refused' in source) return source;
  const from = source.header.source;
  if (from.kind !== 'ticket') {
    return {
      refused: `a seeded run starts from a ticket run: run ${fromRun} started from pull request #${from.number}`,
    };
  }
  const { ticketKey } = from;
  const { branch: sourceBranch, repository } = source.header;
  if (sourceBranch === undefined || repository === undefined) {
    return { refused: `run ${fromRun} started before runs had workspaces: it can't seed a run` };
  }
  const unmarked = unmarkedRefusal(fromRun, source.header, 'seed a run');
  if (unmarked !== undefined) return { refused: unmarked };
  const loaded = await loadWorkflow(found.dir, source.header.workflow.name);
  if ('refused' in loaded) return loaded;
  const models = modelProblems(loaded, config);
  if (models.length > 0) return { refused: models.join('\n') };
  const harnesses = await resolveNamed(options.adapters, found.dir, harnessesReached(loaded, config));
  if ('refused' in harnesses) return harnesses;
  const taken = intakeNameTaken(loaded, found.dir);
  if (taken !== undefined) return { refused: taken };
  const stages = loaded.stages.map((each) => each.definition.name);
  if (!stages.includes(stage)) {
    const known = stages.join(', ');
    return {
      refused: `--stage names '${stage}', which is no stage of workflow '${loaded.name}': its stages are ${known}`,
    };
  }
  let entries: JournalEntry[];
  try {
    ({ entries } = readJournal(source.dir));
  } catch (error) {
    return { refused: `run ${fromRun}'s journal can't be read: ${why(error)}` };
  }
  const [intake] = entries;
  if (intake?.key !== INTAKE_KEY || intake.outcome !== 'passed') {
    return { refused: `run ${fromRun}'s intake didn't pass: there is nothing to reuse` };
  }
  const at = seedEnd(entries, stage);
  if (typeof at !== 'number') {
    return {
      refused: `run ${fromRun}'s ${at.incomplete} has only step lines and no recorded group: sail resume ${fromRun} before seeding it`,
    };
  }
  if (at === -1) return { refused: `run ${fromRun} never ran '${stage}': sail resume ${fromRun} continues it` };
  const seed = entries.slice(0, at);
  const copied = callDirs(source.dir, fromRun, seed);
  if ('refused' in copied) return copied;
  const named = summarize(readEvents(source.dir))?.ticket;
  const ticket = named?.url === undefined ? undefined : { ...named, url: named.url };

  const runId = newRunId(ticketKey, now.getTime(), options.random);
  const branch = `${sourceBranch}-seeded-${runId.slice(-8).toLowerCase()}`;
  const runSource: Source = { kind: 'ticket', ticketKey, via: 'cli', forced: [] };
  const unopened = buildRunHeader({
    runId,
    source: runSource,
    fromRun,
    sailDir: found.dir,
    loaded,
    config,
    adapters: options.adapters.entries,
    harnesses: harnesses.entries,
    now,
  });
  assertRunHeader(unopened);
  if (options.signal?.aborted) return { refused: 'stopped before the run was opened' };

  const root = dirname(found.dir);
  const run: RunRef = { runId, runDir: join(runsDir(found.dir), runId) };
  const { relay } = options.adapters;
  const port = options.adapters.ports.workspace;
  let started: ProviderEvent[] = [];
  const opened = await collecting(relay, root, async (events) => {
    started = events;
    return startWorkspace({
      port,
      run,
      sailDir: found.dir,
      branch,
      base: repository.baseSha,
      signal: options.signal,
    });
  });
  if ('refused' in opened) return opened;
  const { made } = opened;
  const redact = redactor(options.secrets ?? credentialValues(process.env));
  const header: RunHeader = redact.value({
    ...unopened,
    ...workspaceFields({ branch, repository: made.repository, baseSha: made.workspace.baseSha }),
  });
  const dir = run.runDir;
  let journaled: JournalEntry[];
  try {
    assertRunHeader(header);
    for (const path of copied) {
      cpSync(join(source.dir, path), join(dir, path), {
        recursive: true,
        verbatimSymlinks: true,
        force: false,
        errorOnExist: true,
      });
    }
    // A fresh copy, not the source run's: the seeded run is a new run of the workflow as it reads now.
    copyStageFolders(dir, root, header);
    writeRunHeader(dir, header);
    createJournal(dir);
    journaled = seed.map(({ seq: _, recordedAt: __, ...entry }) => appendJournal(dir, entry, now));
    createEventsFile(dir);
    writeStatus(dir, 'running');
  } catch (error) {
    await undoOpened(port, run, made.repository.url, branch);
    throw error;
  }
  return {
    runId,
    dir,
    header,
    redact,
    sailDir: found.dir,
    root,
    adapters: options.adapters.ports,
    portVariables: options.adapters.portVariables,
    harnesses: harnesses.ports,
    relay,
    config,
    loaded,
    workspace: { path: made.workspace.path, branch, baseSha: made.workspace.baseSha, remote: made.repository.url },
    started,
    ...(options.continue === true ? {} : { until: stage }),
    firstSeq: 1,
    seeded: { fromRun, stage, entries: journaled, ...(ticket === undefined ? {} : { ticket }) },
  };
}

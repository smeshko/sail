// Opens a seeded run: a new run whose journal starts with another run's calls, those before a named stage, so a prompt
// can be iterated on without paying for the calls before it. The runtime then drives it as it drives any run: the
// intake is taken from the journal's head, the replay returns each reused call from its line, and the stage's first
// call is the first one that runs.
//
// In order, every refusal before anything is written:
//   1. `.sail/` and its config, then the claim of `.sail/` for the process;
//   2. the source run: a plain name, with a `run.json`, from a run that had a workspace. Any STATUS is accepted, a
//      crashed `running` one included, since only its journal's complete lines are read;
//   3. the workflow as it reads now, its model aliases, and no stage named `intake`;
//   4. the stage, which must be a stage of that workflow;
//   5. the source's journal: an `intake#1` that passed, and a call of the stage. The seed is every entry before the
//      stage's first call.
// Then the run id is minted and the header built and checked, with `fromRun` and no claim: a seeded run reads no
// ticket and claims nothing. An abort seen by then refuses. Then, as a start does, the branch is leased and the run
// directory and the workspace made, each undone on a refusal. The branch is the source's, suffixed
// `-seeded-<the run id's last 8 characters>`, so a seeded run blocks neither its source nor another seeded run.
//
// The reused calls' directories are copied from the source, every try included, so the journal's paths hold in the new
// run directory and the consumed files keep their bytes. A copy that fails undoes the workspace, the run directory and
// the lease, and is thrown on: it is a bug or a disk fault, not a refusal. Then `run.json`, the journal holding the
// seed, the events file and STATUS `running` are written.
//
// The workspace starts at the source's base: the source's code changes are not carried. A reused call's commits are not
// in the seeded workspace, so a later stage that consumes a gitDiff sees only what the seeded run changed.
import { cpSync, existsSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { createEventsFile } from '../events/consumers/ndjson';
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
  startWorkspace,
  undoOpened,
} from './open-run';
import { modelProblems } from './roster';
import { runsDir, type Source, writeStatus } from './run-dir';
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

/** The source run's directory and header, or why it can't seed a run. */
function findSource(sailDir: string, runId: string): { dir: string; header: RunHeader } | { refused: string } {
  if (!isPlainName(runId)) return { refused: `'${runId}' is not a run id` };
  const runs = runsDir(sailDir);
  const dir = join(runs, runId);
  if (!existsSync(join(dir, RUN_HEADER_FILE))) {
    return { refused: `no run '${runId}' in ${relative(dirname(sailDir), runs)}` };
  }
  return { dir, header: readRunHeader(dir) };
}

/** The call directories of `entries`, each once, in order: `NN-<stage>/call-N`, which holds every try. */
function callDirs(entries: readonly JournalEntry[]): string[] {
  return [...new Set(entries.map((entry) => entry.resultPath.split('/').slice(0, 2).join('/')))];
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
  const { branch: sourceBranch, repository } = source.header;
  if (sourceBranch === undefined || repository === undefined) {
    return { refused: `run ${fromRun} started before runs had workspaces: it can't seed a run` };
  }
  const loaded = await loadWorkflow(found.dir, source.header.workflow.name);
  if ('refused' in loaded) return loaded;
  const models = modelProblems(loaded, config);
  if (models.length > 0) return { refused: models.join('\n') };
  const taken = intakeNameTaken(loaded, found.dir);
  if (taken !== undefined) return { refused: taken };
  const stages = loaded.stages.map((each) => each.definition.name);
  if (!stages.includes(stage)) {
    const known = stages.join(', ');
    return {
      refused: `--stage names '${stage}', which is no stage of workflow '${loaded.name}': its stages are ${known}`,
    };
  }
  const { entries } = readJournal(source.dir);
  const [intake] = entries;
  if (intake?.key !== INTAKE_KEY || intake.outcome !== 'passed') {
    return { refused: `run ${fromRun}'s intake didn't pass: there is nothing to reuse` };
  }
  const at = entries.findIndex((entry) => entry.stage === stage);
  if (at === -1) return { refused: `run ${fromRun} never ran '${stage}': sail resume ${fromRun} continues it` };
  const seed = entries.slice(0, at);

  const { ticketKey } = source.header.source;
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
  const header: RunHeader = {
    ...unopened,
    ...workspaceFields({ branch, repository: made.repository, baseSha: made.workspace.baseSha }),
  };
  const dir = run.runDir;
  let journaled: JournalEntry[];
  try {
    for (const path of callDirs(seed)) {
      cpSync(join(source.dir, path), join(dir, path), { recursive: true, verbatimSymlinks: true, errorOnExist: true });
    }
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
    sailDir: found.dir,
    adapters: options.adapters.ports,
    relay,
    config,
    loaded,
    workspace: { path: made.workspace.path, branch, baseSha: made.workspace.baseSha, remote: made.repository.url },
    started,
    claimed: [],
    ...(options.continue === true ? {} : { until: stage }),
    firstSeq: 1,
    seeded: { fromRun, entries: journaled },
  };
}

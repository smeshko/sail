// Opens a fresh run: every check that can refuse comes first, and only then is `.sail-runs/<run id>/` created, holding
// the run header, an empty journal and STATUS `running`. So a refusal leaves nothing behind. Phase 3.2's runtime calls
// this to start a run; phase 3.3's resume opens an existing run directory with `readRunHeader()` instead.
import { dirname, join, relative } from 'node:path';
import { readConfig } from './config';
import { createJournal } from './journal';
import { loadWorkflow } from './load-workflow';
import { createRunDir, LOCAL_SOURCE, type Source, writeStatus } from './run-dir';
import { assertRunHeader, buildRunHeader, type RunHeader, writeRunHeader } from './run-header';
import { newRunId } from './run-id';
import { findSailDir } from './sail-dir';
import { formatIssue } from './schemas';

export interface OpenedRun {
  runId: string;
  /** The absolute run directory. */
  dir: string;
  header: RunHeader;
}

export interface OpenRunOptions {
  /** Where the run starts from: `.sail/` is found from here up to the git root. */
  cwd: string;
  /** The workflow's name, its folder under `.sail/workflows/`. */
  workflow: string;
  /** What the run starts from. The `LOCAL` stub until intake exists. */
  source?: Source;
  /** The run id's time and the header's `startedAt`, from one clock. */
  now?: Date;
}

/**
 * Finds `.sail/`, reads its config and loads the workflow, refusing at the first that fails. It then builds the run
 * header and checks it, all before writing anything. A header that breaks `sail.run.v1` throws: that is a bug in sail,
 * not a refusal. Only then does it create the run directory and write the header, the journal and STATUS.
 */
export async function openRun(options: OpenRunOptions): Promise<OpenedRun | { refused: string }> {
  const { cwd, workflow, source = LOCAL_SOURCE, now = new Date() } = options;
  const found = findSailDir(cwd);
  if ('refused' in found) return found;
  const config = readConfig(found.dir);
  if ('issues' in config) {
    const file = relative(dirname(found.dir), join(found.dir, 'project.yaml'));
    return { refused: config.issues.map((issue) => formatIssue({ ...issue, file })).join('\n') };
  }
  const loaded = await loadWorkflow(found.dir, workflow);
  if ('refused' in loaded) return loaded;

  const runId = newRunId(source.ticketKey, now.getTime());
  const header = buildRunHeader({ runId, source, sailDir: found.dir, loaded, config, now });
  assertRunHeader(header);

  const dir = createRunDir(found.dir, runId);
  writeRunHeader(dir, header);
  createJournal(dir);
  writeStatus(dir, 'running');
  return { runId, dir, header };
}

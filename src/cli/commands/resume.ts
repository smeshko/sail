// `sail resume <run> [--input <json>] [-q|-v|-vv]`: resumes a suspended or crashed run of the repository sail is run from, and runs
// it to its end from its journal. It takes `sail run`'s steps: the run's workflow is type-checked first, so a wrongly
// wired stage never runs, and every refusal comes before the run's STATUS changes. A workflow changed since the run
// started isn't refused: the determinism guard decides whether the journal still fits it.
//
// Ctrl-C or SIGTERM suspends the run again, as it does during `sail run`, and the command prints how to resume it.
//
// The terminal view shows the whole run: it reads the run's earlier events first, prints nothing for them, and opens
// with what already ran once the resume's first event arrives. A resume refused before then prints nothing.
import { findWorkflowFile } from '../../engine/load-workflow';
import { findRun } from '../../engine/open-run';
import { resumeWorkflow } from '../../engine/runtime';
import { readEvents } from '../../events/consumers/ndjson';
import type { ExitCode } from '../exit-codes';
import type { Io, Parsed } from '../index';
import {
  findProject,
  interruptibly,
  parseInputOption,
  printEnd,
  refuseAs,
  terminalFor,
  typecheckWorkflow,
  verbosityOf,
} from './run-workflow';

const COMMAND = 'sail resume';

export async function resume(args: Parsed, io: Io): Promise<ExitCode> {
  const refuse = refuseAs(io, COMMAND);
  const [runId] = args.positionals;
  if (runId === undefined) return refuse('usage: sail resume <run> [--input <json>]');
  const given = parseInputOption(args, io, COMMAND);
  if (typeof given === 'number') return given;
  const verbosity = verbosityOf(args, io, COMMAND);
  if (typeof verbosity === 'number') return verbosity;
  const project = findProject(io, COMMAND);
  if (typeof project === 'number') return project;

  const run = findRun(project.sailDir, runId);
  if ('refused' in run) return refuse(run.refused);
  const workflowFile = findWorkflowFile(project.sailDir, run.header.workflow.name);
  if ('refused' in workflowFile) return refuse(workflowFile.refused);
  const typed = await typecheckWorkflow(io, COMMAND, project.sailDir, workflowFile.file);
  if (typed !== undefined) return typed;

  const terminal = terminalFor(io, project.sailDir, verbosity, readEvents(run.dir));
  // Closed however the run ends, so a throw never leaves the live line or its timer behind.
  const end = await interruptibly(io, (signal) =>
    resumeWorkflow({
      cwd: io.cwd,
      runId,
      ...(given.input === undefined ? {} : { input: given.input }),
      signal,
      consumers: [terminal],
    }).finally(() => terminal.close()),
  );
  if ('refused' in end) return refuse(end.refused);
  return printEnd(end, io, given.raw);
}

// `sail resume <run> [--raise-budget <usd>] [--raise-minutes <minutes>] [-q|-v|-vv]`: resumes a suspended or crashed
// run of the repository sail is run from, and runs it to its end from its journal. It takes `sail <ticket>`'s steps:
// the run's workflow is type-checked first, so a wrongly wired stage never runs, and every refusal comes before the
// run's STATUS changes. A workflow changed since the run started isn't refused: the determinism guard decides whether
// the journal still fits it. It asks nothing of the ticket and claims nothing: the run's input is in its journal.
//
// A raise adds to the run's budget, and is recorded in its events before anything runs: a run suspended over its budget
// resumes only with one that takes it back under, and a raise of a budget the run doesn't have is refused. So is a
// raise under 0.01, which the terminal would print as `$0.00` or `0 min`.
//
// Ctrl-C or SIGTERM suspends the run again, as it does during `sail <ticket>`, and the command prints how to resume it.
//
// The terminal view shows the whole run: it reads the run's earlier events first, prints nothing for them, and opens
// with what already ran once the resume's first event arrives. A resume refused before then prints nothing.
import { dirname, join, relative } from 'node:path';
import type { Raise } from '../../engine/budget';
import { systemKeepAwake } from '../../engine/keep-awake';
import { findWorkflowFile } from '../../engine/load-workflow';
import { findRun } from '../../engine/open-run';
import { credentialValues } from '../../engine/redact';
import { DEFINITION_DIR } from '../../engine/run-dir';
import { resumeWorkflow } from '../../engine/runtime';
import { readEvents } from '../../events/consumers/ndjson';
import type { ExitCode } from '../exit-codes';
import type { Io, Parsed } from '../index';
import { registerRepository } from '../registration';
import {
  findProject,
  interruptibly,
  printEnd,
  recorded,
  refuseAs,
  terminalFor,
  typecheckWorkflow,
  verbosityOf,
} from './run-workflow';

const COMMAND = 'sail resume';

/** The raise the flags ask for, or why one of them isn't a positive number, or is under 0.01, which prints as nothing. */
function raiseOf(args: Parsed): Raise | { refused: string } {
  const raise: Raise = {};
  const flags = [
    ['raise-budget', 'usd', 'dollars'],
    ['raise-minutes', 'minutes', 'minutes'],
  ] as const;
  for (const [flag, field, unit] of flags) {
    const given = args.values[flag];
    if (typeof given !== 'string') continue;
    const value = Number(given);
    if (given.trim() === '' || !Number.isFinite(value) || value <= 0) {
      return { refused: `--${flag} takes a positive number of ${unit}: '${given}'` };
    }
    if (value < 0.01) return { refused: `--${flag} takes at least 0.01 ${unit}: '${given}'` };
    raise[field] = value;
  }
  return raise;
}

export async function resume(args: Parsed, io: Io): Promise<ExitCode> {
  const refuse = refuseAs(io, COMMAND);
  const [runId] = args.positionals;
  if (runId === undefined) return refuse('usage: sail resume <run>');
  const raise = raiseOf(args);
  if ('refused' in raise) return refuse(raise.refused);
  const verbosity = verbosityOf(args, io, COMMAND);
  if (typeof verbosity === 'number') return verbosity;
  const clone = await findProject(io, COMMAND);
  if (typeof clone === 'number') return clone;

  const run = findRun(clone.sailDir, runId);
  if ('refused' in run) return refuse(run.refused);
  // Every run resumes on its own copy of `.sail/`, whatever the clone's holds.
  const project = await findProject(io, COMMAND, {
    found: { dir: join(run.dir, DEFINITION_DIR, '.sail') },
    label:
      run.header.definitionsSha === undefined
        ? `${relative(dirname(clone.sailDir), run.dir)}/${DEFINITION_DIR}/.sail/project.yaml`
        : `${run.header.definitionsSha.slice(0, 7)}:.sail/project.yaml`,
    root: dirname(clone.sailDir),
  });
  if (typeof project === 'number') return project;
  const workflowFile = findWorkflowFile(project.sailDir, run.header.workflow.name);
  if ('refused' in workflowFile) return refuse(workflowFile.refused);
  const typed = await typecheckWorkflow(io, COMMAND, project.sailDir, workflowFile.file);
  if (typed !== undefined) return typed;
  await registerRepository(io, COMMAND, clone);
  const recording = recorded(args, io, { sailDir: clone.sailDir, adapters: project.adapters });

  const terminal = terminalFor(io, clone.sailDir, verbosity, readEvents(run.dir));
  // Closed however the run ends, so a throw never leaves the live line or its timer behind.
  const end = await interruptibly(io, (signal) =>
    resumeWorkflow({
      secrets: credentialValues(io.env ?? process.env),
      cwd: io.cwd,
      runId,
      ...(Object.keys(raise).length === 0 ? {} : { raise }),
      adapters: recording?.adapters ?? project.adapters,
      signal,
      keepAwake: io.keepAwake ?? systemKeepAwake(io.env ?? process.env),
      consumers: [terminal],
    }).finally(() => terminal.close()),
  );
  if ('refused' in end) return refuse(end.refused);
  recording?.finish(end.dir);
  return printEnd(end, io);
}

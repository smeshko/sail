// `sail run --from-run <run> --stage <stage> [--continue] [-q|-v|-vv]`: starts a seeded run in the repository sail is
// run from. It reuses the calls the source run made before the stage, runs the stage, and stops after its first call,
// suspended, so `sail resume` takes it on. With `--continue` it runs the rest of the workflow too. It takes `sail
// resume`'s steps: the source's workflow is type-checked first, and every refusal is one `sail run: <message>` line with
// exit 3, before anything is written. It asks nothing of the ticket and claims nothing.
//
// Ctrl-C or SIGTERM stops the running call and suspends the run, as during `sail <ticket>`. One seen before the run is
// opened is a refusal: nothing was written.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { isPlainName } from '../../engine/call-dir';
import { findWorkflowFile } from '../../engine/load-workflow';
import { runsDir } from '../../engine/run-dir';
import { RUN_HEADER_FILE, readRunHeader } from '../../engine/run-header';
import { runSeededWorkflow } from '../../engine/runtime';
import type { ExitCode } from '../exit-codes';
import type { Io, Parsed } from '../index';
import { registerRepository } from '../registration';
import {
  findProject,
  interruptibly,
  printEnd,
  refuseAs,
  terminalFor,
  typecheckWorkflow,
  verbosityOf,
} from './run-workflow';

const COMMAND = 'sail run';

/** The workflow the source run in `dir` ran, when its header can be read. */
function workflowOf(dir: string, source: string): string | undefined {
  if (!isPlainName(source) || !existsSync(join(dir, RUN_HEADER_FILE))) return undefined;
  try {
    return readRunHeader(dir).workflow.name;
  } catch {
    return undefined;
  }
}

export async function fromRun(args: Parsed, io: Io): Promise<ExitCode> {
  const refuse = refuseAs(io, COMMAND);
  const source = args.values['from-run'];
  const { stage } = args.values;
  if (typeof source !== 'string' || typeof stage !== 'string') {
    return refuse('usage: sail run --from-run <run> --stage <stage> [--continue]');
  }
  const verbosity = verbosityOf(args, io, COMMAND);
  if (typeof verbosity === 'number') return verbosity;
  const project = await findProject(io, COMMAND);
  if (typeof project === 'number') return project;

  // The source's workflow is the one to type-check. The engine refuses the run's other problems in its own words, a
  // run.json that can't be read among them.
  const named = workflowOf(join(runsDir(project.sailDir), source), source);
  if (named !== undefined) {
    const workflowFile = findWorkflowFile(project.sailDir, named);
    if ('refused' in workflowFile) return refuse(workflowFile.refused);
    const typed = await typecheckWorkflow(io, COMMAND, project.sailDir, workflowFile.file);
    if (typed !== undefined) return typed;
    await registerRepository(io, COMMAND, project);
  }

  const terminal = terminalFor(io, project.sailDir, verbosity);
  // Closed however the run ends, so a throw never leaves the live line or its timer behind.
  const end = await interruptibly(io, (signal) =>
    runSeededWorkflow({
      cwd: io.cwd,
      fromRun: source,
      stage,
      continue: args.values.continue === true,
      adapters: project.adapters,
      signal,
      consumers: [terminal],
    }).finally(() => terminal.close()),
  );
  if ('refused' in end) return refuse(end.refused);
  return printEnd(end, io);
}

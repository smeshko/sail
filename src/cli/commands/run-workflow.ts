// `sail <ticket> [--workflow <name>] [--force] [--until <stage>] [-q|-v|-vv]`: starts a run from a ticket in the
// repository sail is run from, and runs its workflow to its end, or to the stage `--until` names. The workflow is
// type-checked first, so a wrongly wired stage never runs. Every refusal is one `sail <ticket as typed>: <message>` line
// with exit code 3, and comes before the run directory exists: the config and its adapters, the workflow, its types,
// and then what the engine refuses of the workflow and of the ticket. This module parses, hands the run's events to
// the terminal view and maps the run's status to an exit code; the run is the engine's, and so are the ticket's checks
// and its claim. Everything the command prints during the run comes from its events.
//
// Ctrl-C or SIGTERM while the run runs stops the running call and suspends the run, and the command prints how to
// resume it. One that arrives while the run is being opened, before its ticket is claimed, is a refusal: the ticket is
// as it was, and nothing exists to resume. Earlier still, during the type-check, it ends sail the default way.
//
// `sail resume` takes the same steps: the helpers exported here are the ones both commands run, so they can't drift.
import { join, relative } from 'node:path';
import { BUILTINS } from '../../adapters/index';
import { type ResolvedAdapters, resolveAdapters } from '../../engine/adapters';
import { type Port, type ProjectConfig, readConfig } from '../../engine/config';
import { findWorkflowFile } from '../../engine/load-workflow';
import { runsDir } from '../../engine/run-dir';
import { type RunEnd, runWorkflow } from '../../engine/runtime';
import { findSailDir } from '../../engine/sail-dir';
import { formatIssue } from '../../engine/schemas';
import { typecheck } from '../../engine/typecheck';
import { type TerminalConsumer, terminalConsumer, type Verbosity } from '../../events/consumers/terminal';
import type { SailEvent } from '../../events/types';
import { EXIT_INTERNAL, EXIT_REFUSED, type ExitCode, exitCodeFor } from '../exit-codes';
import { count, formatDiagnostic } from '../format';
import type { Io, Parsed } from '../index';

/** Every path a command prints goes through here, relative to where the user ran it. */
export function at(io: Io, path: string): string {
  return relative(io.cwd, path) || '.';
}

/** A refusal of `command`, such as `sail resume`: prints `<command>: <message>` and returns the refused exit code. */
export function refuseAs(io: Io, command: string): (message: string) => ExitCode {
  return (message) => {
    io.stderr(`${command}: ${message}\n`);
    return EXIT_REFUSED;
  };
}

/** The verbosity `-q` and `-v` ask for: `-v` is verbose, and `-vv` or more is trace. `-q` with any `-v` refuses. */
export function verbosityOf(args: Parsed, io: Io, command: string): Verbosity | ExitCode {
  const quiet = args.values.quiet === true;
  const verbose = typeof args.values.verbose === 'number' ? args.values.verbose : 0;
  if (quiet && verbose > 0) return refuseAs(io, command)("-q and -v can't be combined");
  if (verbose >= 2) return 'trace';
  if (verbose === 1) return 'verbose';
  return quiet ? 'quiet' : 'normal';
}

/**
 * `.sail/`, found from where sail runs, its config and the adapters it names. A config or an adapter with issues prints
 * each and refuses. `only` narrows it for a command that needs less: a `.sail/` it found its own way, and the ports to
 * resolve, so no other adapter is loaded or asked for its credentials.
 */
export async function findProject<P extends Port = Port>(
  io: Io,
  command: string,
  only: { found?: { dir: string } | { refused: string }; ports?: readonly P[] } = {},
): Promise<{ sailDir: string; config: ProjectConfig; adapters: ResolvedAdapters<P> } | ExitCode> {
  const found = only.found ?? findSailDir(io.cwd);
  if ('refused' in found) return refuseAs(io, command)(found.refused);
  const config = readConfig(found.dir);
  const file = at(io, join(found.dir, 'project.yaml'));
  if ('issues' in config) {
    for (const issue of config.issues) io.stderr(`${formatIssue({ ...issue, file })}\n`);
    return EXIT_REFUSED;
  }
  const adapters = await resolveAdapters({
    sailDir: found.dir,
    config,
    builtins: BUILTINS,
    env: io.env ?? process.env,
    ...(only.ports === undefined ? {} : { ports: only.ports }),
  });
  if ('issues' in adapters) {
    for (const issue of adapters.issues) io.stderr(`${formatIssue({ ...issue, file })}\n`);
    return EXIT_REFUSED;
  }
  return { sailDir: found.dir, config, adapters };
}

/**
 * Type-checks what runs: the workflow's import graph, so a half-edited file elsewhere doesn't block it. Undefined when
 * it type-checks. Type errors print and refuse, and a `tsc` that can't run is internal.
 */
export async function typecheckWorkflow(
  io: Io,
  command: string,
  sailDir: string,
  workflowFile: string,
): Promise<ExitCode | undefined> {
  const types = await typecheck(sailDir, { files: [workflowFile] });
  if ('internal' in types) {
    io.stderr(`${command}: could not run tsc\n${types.internal}\n`);
    return EXIT_INTERNAL;
  }
  if (types.ok) return undefined;
  for (const diagnostic of types.diagnostics) io.stderr(`${formatDiagnostic(diagnostic, (path) => at(io, path))}\n`);
  const errors = types.diagnostics.filter((diagnostic) => diagnostic.code !== '').length;
  return refuseAs(io, command)(`${count(errors, 'type error')} in ${at(io, workflowFile)}`);
}

/** Runs `body` with a signal that Ctrl-C or SIGTERM aborts. The handler is registered only while `body` runs. */
export async function interruptibly<T>(io: Io, body: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const unregister = io.onInterrupt?.(() => controller.abort());
  try {
    return await body(controller.signal);
  } finally {
    unregister?.();
  }
}

/**
 * The terminal view of a run at `verbosity`, written to stdout: coloured, with a live line, only when `io.tty` says
 * stdout is an interactive terminal. A resume passes the run's earlier events as `prior`, so the view covers the whole
 * run.
 */
export function terminalFor(
  io: Io,
  sailDir: string,
  verbosity: Verbosity,
  prior?: readonly SailEvent[],
): TerminalConsumer {
  const runs = runsDir(sailDir);
  return terminalConsumer({
    verbosity,
    write: (text) => io.stdout(text),
    ...(io.tty === undefined ? {} : { tty: io.tty }),
    runsDir: runs,
    shownRunsDir: at(io, runs),
    ...(prior === undefined ? {} : { prior }),
  });
}

/** After the terminal view's final block, prints how to resume a suspended run. Returns the status's exit code. */
export function printEnd(end: RunEnd, io: Io): ExitCode {
  if (end.status === 'suspended') io.stdout(`resume it with: sail resume ${end.runId}\n`);
  return exitCodeFor(end.status);
}

/** `sail <ticket>`: the dispatch hands it the ticket as its one positional. */
export async function runWorkflowCommand(args: Parsed, io: Io): Promise<ExitCode> {
  const [ticket = ''] = args.positionals;
  // A refusal names the ticket as it was typed: the ticket source may not even parse it.
  const command = `sail ${ticket}`;
  const refuse = refuseAs(io, command);
  const verbosity = verbosityOf(args, io, command);
  if (typeof verbosity === 'number') return verbosity;
  const project = await findProject(io, command);
  if (typeof project === 'number') return project;

  const named = args.values.workflow;
  const workflow = typeof named === 'string' ? named : project.config.defaultWorkflow;
  if (workflow === undefined) return refuse('no --workflow given, and .sail/project.yaml sets no defaultWorkflow');
  const workflowFile = findWorkflowFile(project.sailDir, workflow);
  if ('refused' in workflowFile) return refuse(workflowFile.refused);
  const typed = await typecheckWorkflow(io, command, project.sailDir, workflowFile.file);
  if (typed !== undefined) return typed;

  const { until } = args.values;
  const terminal = terminalFor(io, project.sailDir, verbosity);
  // Closed however the run ends, so a throw never leaves the live line or its timer behind.
  const end = await interruptibly(io, (signal) =>
    runWorkflow({
      cwd: io.cwd,
      workflow,
      ticket,
      force: args.values.force === true,
      ...(typeof until === 'string' ? { until } : {}),
      adapters: project.adapters,
      signal,
      consumers: [terminal],
    }).finally(() => terminal.close()),
  );
  if ('refused' in end) return refuse(end.refused);
  return printEnd(end, io);
}

// `sail run [--workflow <name>] [--input <json>]`: runs a workflow of the repository sail is run from, to its end. The
// workflow is type-checked first, so a wrongly wired stage never runs. Every refusal comes before the run directory
// exists. This module parses, prints and maps the run's status to an exit code; the run is the engine's.
//
// Ctrl-C or SIGTERM while the run runs stops the running call and suspends the run, and the command prints how to
// resume it. Before the run starts, a Ctrl-C ends sail the default way: nothing exists yet to resume.
import { join, relative } from 'node:path';
import { readConfig } from '../../engine/config';
import type { JournalEntry } from '../../engine/journal';
import { findWorkflowFile } from '../../engine/load-workflow';
import { type RunEnd, runWorkflow } from '../../engine/runtime';
import { findSailDir } from '../../engine/sail-dir';
import { formatIssue } from '../../engine/schemas';
import { typecheck } from '../../engine/typecheck';
import { EXIT_INTERNAL, EXIT_REFUSED, type ExitCode, exitCodeFor } from '../exit-codes';
import { count, formatDiagnostic } from '../format';
import type { Io, Parsed } from '../index';

/** Prints each journaled call as `<key> <outcome>`. */
export function printCall(io: Io): (entry: JournalEntry) => void {
  return (entry) => io.stdout(`${entry.key} ${entry.outcome}\n`);
}

/**
 * Prints how a run ended, `<run id> <status>[ <stop reason>: <message>]  <dir>`, and for a suspended run how to resume
 * it, repeating `--input` quoted for a POSIX shell. Returns the status's exit code.
 */
export function printEnd(end: RunEnd, io: Io, rawInput: string | undefined): ExitCode {
  const stopped = end.status === 'completed' ? '' : ` ${end.stopReason}: ${end.message}`;
  io.stdout(`${end.runId} ${end.status}${stopped}  ${relative(io.cwd, end.dir) || '.'}\n`);
  if (end.status === 'suspended') {
    const input = rawInput === undefined ? '' : ` --input '${rawInput.replaceAll("'", "'\\''")}'`;
    io.stdout(`resume it with: sail resume ${end.runId}${input}\n`);
  }
  return exitCodeFor(end.status);
}

export async function runWorkflowCommand(args: Parsed, io: Io): Promise<ExitCode> {
  /** Every path the command prints goes through here, relative to where the user ran it. */
  const at = (path: string) => relative(io.cwd, path) || '.';
  const refuse = (message: string): ExitCode => {
    io.stderr(`sail run: ${message}\n`);
    return EXIT_REFUSED;
  };

  let input: unknown;
  const given = args.values.input;
  if (typeof given === 'string') {
    try {
      input = JSON.parse(given);
    } catch (error) {
      return refuse(`--input is not JSON: ${(error as Error).message}`);
    }
  }

  const found = findSailDir(io.cwd);
  if ('refused' in found) return refuse(found.refused);
  const config = readConfig(found.dir);
  if ('issues' in config) {
    const file = at(join(found.dir, 'project.yaml'));
    for (const issue of config.issues) io.stderr(`${formatIssue({ ...issue, file })}\n`);
    return EXIT_REFUSED;
  }

  const named = args.values.workflow;
  const workflow = typeof named === 'string' ? named : config.defaultWorkflow;
  if (workflow === undefined) return refuse('no --workflow given, and .sail/project.yaml sets no defaultWorkflow');
  const workflowFile = findWorkflowFile(found.dir, workflow);
  if ('refused' in workflowFile) return refuse(workflowFile.refused);

  // What runs is type-checked: the workflow's import graph, so a half-edited file elsewhere doesn't block it.
  const types = await typecheck(found.dir, { files: [workflowFile.file] });
  if ('internal' in types) {
    io.stderr(`sail run: could not run tsc\n${types.internal}\n`);
    return EXIT_INTERNAL;
  }
  if (!types.ok) {
    for (const diagnostic of types.diagnostics) io.stderr(`${formatDiagnostic(diagnostic, at)}\n`);
    const errors = types.diagnostics.filter((diagnostic) => diagnostic.code !== '').length;
    return refuse(`${count(errors, 'type error')} in ${at(workflowFile.file)}`);
  }

  const controller = new AbortController();
  const unregister = io.onInterrupt?.(() => controller.abort());
  let end: Awaited<ReturnType<typeof runWorkflow>>;
  try {
    end = await runWorkflow({
      cwd: io.cwd,
      workflow,
      ...(input === undefined ? {} : { input }),
      signal: controller.signal,
      onCall: printCall(io),
    });
  } finally {
    unregister?.();
  }
  if ('refused' in end) return refuse(end.refused);
  return printEnd(end, io, typeof given === 'string' ? given : undefined);
}

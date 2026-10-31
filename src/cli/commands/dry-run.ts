// `sail <ticket> --dry-run`: the start's whole preflight, then the roster the run would freeze, printed. The config, its
// adapters and the type check are `sail <ticket>`'s own steps, before this module is reached. The engine's `dryRun()`
// then runs every check a start runs and reads the branch's lease. A refusal reads as the start's, `sail <ticket>:
// <message>` with exit 3, or 5 for a ticket that waits on an open prerequisite. Otherwise the roster goes to stdout with exit 0. Nothing is written: no run directory,
// workspace, lease, claim, comment or registry entry.
//
// The lines are the dry run's own, built here from the header a start would freeze, never derived again: the run's
// ticket, branch, adapters, run budget and forced checks, then the intake and each stage in the roster's order. A field
// that is absent or empty is left out.
import type { ResolvedAdapters } from '../../engine/adapters';
import { dryRun } from '../../engine/dry-run';
import type { IntakeEntry, RosterEntry, StepRosterEntry } from '../../engine/roster';
import type { RunHeader } from '../../engine/run-header';
import { EXIT_OK, EXIT_REFUSED, EXIT_WAITING, type ExitCode } from '../exit-codes';
import type { Io } from '../index';

const NOTHING_WRITTEN = 'dry run: nothing was written: no run directory, workspace, lease, claim or comment';

/** `label` padded to the value column, then `value`, under `indent`. */
const field = (indent: string, label: string, value: string) => `${indent}${label.padEnd(10)}${value}`;

/** A budget as people read it: `30 turns, $1, 5 min`, each part only when set. */
function budgetOf(budget: { maxTurns?: number; maxUsd?: number; maxMinutes?: number }): string {
  const parts: string[] = [];
  if (budget.maxTurns !== undefined) parts.push(`${budget.maxTurns} turns`);
  if (budget.maxUsd !== undefined) parts.push(`$${budget.maxUsd}`);
  if (budget.maxMinutes !== undefined) parts.push(`${budget.maxMinutes} min`);
  return parts.join(', ');
}

/** The lines of what a stage or a step declares, each under `indent`: absent and empty fields are left out. */
function entryLines(entry: RosterEntry | StepRosterEntry, indent: string): string[] {
  const lines: string[] = [];
  const list = (label: string, values: readonly (string | number)[] | undefined) => {
    if (values !== undefined && values.length > 0) lines.push(field(indent, label, values.join(', ')));
  };
  if (entry.model !== undefined) lines.push(field(indent, 'model', entry.model));
  if (entry.harness !== undefined) lines.push(field(indent, 'harness', entry.harness));
  if (entry.budget !== undefined) lines.push(field(indent, 'budget', budgetOf(entry.budget)));
  list('produces', entry.produces);
  const { permissions } = entry;
  list('read', permissions?.read);
  list('write', permissions?.write);
  list('commands', permissions?.commands);
  const network = entry.network ?? permissions?.network;
  if (network !== undefined)
    lines.push(field(indent, 'network', typeof network === 'string' ? network : network.join(', ')));
  list('tools', permissions?.tools);
  if ('exitCodes' in entry && entry.exitCodes !== undefined) {
    const codes = Object.entries(entry.exitCodes)
      .filter(([, values]) => values !== undefined && values.length > 0)
      .map(([outcome, values]) => `${outcome} ${(values as readonly number[]).join(' ')}`);
    if (codes.length > 0) lines.push(field(indent, 'exit', codes.join(', ')));
  }
  return lines;
}

function stageLines(name: string, entry: RosterEntry): string[] {
  if (entry.steps === undefined) {
    return [`stage ${name}  ${entry.kind ?? 'steps'}  ${entry.origin}`, ...entryLines(entry, '  ')];
  }
  return [
    `stage ${name}  steps  ${entry.origin}`,
    ...entryLines(entry, '  '),
    ...entry.steps.flatMap((step) => [`  step ${step.step}  ${step.kind}`, ...entryLines(step, '    ')]),
  ];
}

function intakeLines(intake: IntakeEntry): string[] {
  return [`intake ${intake.name}  ${intake.origin}`, ...entryLines(intake, '  ')];
}

/** The roster a start would freeze, as the dry run prints it: from a ticket, or from a pull request at its head sha. */
export function rosterText(
  header: RunHeader,
  from: { title: string; state: { name: string } } | { title: string; state: string },
  branch: string,
) {
  const { workflow, source, adapters, budget } = header;
  const on = source.kind === 'ticket' ? source.ticketKey : `#${source.number}`;
  const state = typeof from.state === 'string' ? from.state : from.state.name;
  const lines = [`${workflow.name}@${workflow.version} on ${on}: ${from.title} (${state})`];
  lines.push(field('  ', 'branch', branch));
  if (source.kind === 'pr') lines.push(field('  ', 'head', source.headSha));
  const { harnesses, ...ports } = adapters;
  const used = [
    ...Object.entries(ports).map(([port, entry]) => `${port} ${entry.use} (${entry.origin})`),
    ...Object.entries(harnesses ?? {}).map(([name, entry]) => `harnesses.${name} ${entry.use} (${entry.origin})`),
  ];
  lines.push(field('  ', 'adapters', used.join(', ')));
  if (budget !== undefined) lines.push(field('  ', 'budget', `run ${budgetOf(budget)}`));
  if (source.forced.length > 0) lines.push(field('  ', 'forced', source.forced.join(', ')));
  lines.push(...intakeLines(header.intake));
  for (const [name, entry] of Object.entries(header.stages)) lines.push(...stageLines(name, entry));
  lines.push(NOTHING_WRITTEN);
  return `${lines.join('\n')}\n`;
}

export interface DryRunTicket {
  workflow: string;
  ticket: string;
  force: boolean;
  ignorePrerequisites?: boolean;
  until?: string;
}

/** Runs the dry run of `sail <ticket>`, printing the roster or the start's refusal. */
export async function dryRunTicket(
  io: Io,
  command: string,
  project: { adapters: ResolvedAdapters },
  options: DryRunTicket,
): Promise<ExitCode> {
  const result = await dryRun({
    cwd: io.cwd,
    workflow: options.workflow,
    ticket: options.ticket,
    force: options.force,
    ...(options.ignorePrerequisites === true ? { ignorePrerequisites: true } : {}),
    ...(options.until === undefined ? {} : { until: options.until }),
    adapters: project.adapters,
  });
  if ('refused' in result) {
    io.stderr(`${command}: ${result.refused}\n`);
    return result.waitingOn === undefined ? EXIT_REFUSED : EXIT_WAITING;
  }
  const from = result.ticket ?? result.pullRequest;
  if (from === undefined) throw new Error('a dry run found neither a ticket nor a pull request');
  io.stdout(rosterText(result.header, from, result.branch));
  return EXIT_OK;
}

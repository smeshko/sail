// `sail check [--list]`: finds `.sail/`, validates its config, type-checks it and loads its definitions, in that order.
// The first step with a problem refuses, with every problem it found located relative to where the user ran it.
import { join, relative } from 'node:path';
import { loadDefinitions } from '../../engine/definitions';
import { findSailDir, projectIssues } from '../../engine/sail-dir';
import { formatIssue } from '../../engine/schemas';
import { type Diagnostic, typecheck } from '../../engine/typecheck';
import { EXIT_INTERNAL, EXIT_OK, EXIT_REFUSED, type ExitCode } from '../exit-codes';
import type { Io } from '../index';

const count = (n: number, noun: string) => `${n} ${noun}${n === 1 ? '' : 's'}`;

/** Rows as columns two spaces apart, indented by two. A column that is empty in every row is left out. */
function columns(rows: readonly (readonly string[])[]): string {
  const widths = (rows[0] ?? []).map((_, i) => Math.max(...rows.map((row) => (row[i] ?? '').length)));
  const kept = widths.flatMap((width, i) => (width === 0 ? [] : [i]));
  return rows
    .map((row) => `  ${kept.map((i) => (row[i] ?? '').padEnd(widths[i] ?? 0)).join('  ')}`.trimEnd())
    .join('\n');
}

export async function check(args: readonly string[], io: Io): Promise<ExitCode> {
  /** Every path the command prints goes through here, relative to where the user ran it. */
  const at = (path: string) => relative(io.cwd, path) || '.';

  const found = findSailDir(io.cwd);
  if ('refused' in found) {
    io.stderr(`sail check: ${found.refused}\n`);
    return EXIT_REFUSED;
  }
  const sail = `${at(found.dir)}/`;

  const issues = projectIssues(found.dir);
  if (issues.length > 0) {
    const file = at(join(found.dir, 'project.yaml'));
    for (const issue of issues) io.stderr(`${formatIssue({ ...issue, file })}\n`);
    return EXIT_REFUSED;
  }

  const types = await typecheck(found.dir);
  if ('internal' in types) {
    io.stderr(`sail check: could not run tsc\n${types.internal}\n`);
    return EXIT_INTERNAL;
  }
  if (!types.ok) {
    const format = ({ file, line, column, code, message }: Diagnostic) =>
      `${file === undefined ? '' : `${at(file)}:${line}:${column}  `}${code === '' ? '' : `${code}  `}${message}`;
    for (const diagnostic of types.diagnostics) io.stderr(`${format(diagnostic)}\n`);
    const errors = types.diagnostics.filter((diagnostic) => diagnostic.code !== '').length;
    io.stderr(`sail check: ${count(errors, 'type error')} in ${sail}\n`);
    return EXIT_REFUSED;
  }

  const { workflows, stages, problems } = await loadDefinitions(found.dir);
  if (problems.length > 0) {
    for (const problem of problems) io.stderr(`${at(problem.file)}  ${problem.message}\n`);
    return EXIT_REFUSED;
  }

  io.stdout(`${sail} checked: ${count(workflows.length, 'workflow')}, ${count(stages.length, 'stage')}\n`);
  if (args.includes('--list')) {
    if (workflows.length > 0) {
      io.stdout(`\nworkflows\n${columns(workflows.map((w) => [w.name, `intake ${w.intake}`, at(w.file)]))}\n`);
    }
    if (stages.length > 0) {
      const steps = (s: (typeof stages)[number]) => s.steps.map((step) => `${step.name} (${step.kind})`).join(', ');
      io.stdout(`\nstages\n${columns(stages.map((s) => [s.name, s.kind, steps(s), at(s.file)]))}\n`);
    }
  }
  return EXIT_OK;
}

// `sail check [--list]`: finds `.sail/`, validates its config, refreshes the editor declarations, type-checks it,
// loads its definitions and applies the layout's rules, then asks each harness whether it can run the models the
// aliases route to it, in that order. The first step with a problem refuses, with
// every problem it found located relative to where the user ran it.
//
// The editor declarations are the one thing it writes: where `.sail/tsconfig.json` shows the repository uses them, the
// ones that are missing or name another sail are rewritten, so one `sail check` sets a fresh clone or a new worktree up
// for the editor. A write that fails is a line on stderr and nothing more: the check's answer is the check's own.
import { existsSync } from 'node:fs';
import { basename, dirname, join, relative } from 'node:path';
import { BUILTINS } from '../../adapters/index';
import { checkModelAliases } from '../../engine/adapters';
import { readConfig } from '../../engine/config';
import { byFile, type Definitions, loadDefinitions, type StageEntry } from '../../engine/definitions';
import { EditorWriteError, writeEditorDeclarations } from '../../engine/editor';
import { type ImportGraph, importGraph } from '../../engine/imports';
import { layoutProblems, reach } from '../../engine/layout';
import { findSailDir } from '../../engine/sail-dir';
import { formatIssue } from '../../engine/schemas';
import { typecheck } from '../../engine/typecheck';
import { EXIT_INTERNAL, EXIT_OK, EXIT_REFUSED, type ExitCode } from '../exit-codes';
import { count, formatDiagnostic } from '../format';
import type { Io, Parsed } from '../index';

/**
 * Rows as lines of columns two spaces apart, each indented by `indent`. A row may be shorter than the others, and a
 * column empty in every row is left out.
 */
function columns(rows: readonly (readonly string[])[], indent = 2): string[] {
  const count = Math.max(0, ...rows.map((row) => row.length));
  const widths = Array.from({ length: count }, (_, i) => Math.max(...rows.map((row) => (row[i] ?? '').length)));
  const kept = widths.flatMap((width, i) => (width === 0 ? [] : [i]));
  const pad = ' '.repeat(indent);
  return rows.map((row) => `${pad}${kept.map((i) => (row[i] ?? '').padEnd(widths[i] ?? 0)).join('  ')}`.trimEnd());
}

/**
 * `--list`: each workflow with its private intake and stages, ordered by folder, then the shared stages it reaches.
 * Then every shared stage, with the workflows reaching it. Stage rows share their widths across every workflow.
 */
function listing(definitions: Definitions, graph: ImportGraph, at: (path: string) => string): string {
  const { workflows, intakes, stages } = definitions;
  const reached = workflows.map((workflow) => reach(workflow, definitions, graph));
  const row = (stage: StageEntry) => [
    stage.name,
    stage.kind,
    stage.steps.map((s) => `${s.name} (${s.kind})`).join(', '),
  ];
  const folder = (stage: StageEntry) => basename(dirname(stage.file));
  const groups = workflows.map((workflow, i) => ({
    private: [
      ...intakes.filter((intake) => intake.workflow === workflow.folder).map((intake) => [intake.name, 'intake']),
      ...stages
        .filter((stage) => stage.workflow === workflow.folder)
        .sort((a, b) => (folder(a) < folder(b) ? -1 : 1))
        .map(row),
    ],
    shared: (reached[i] ?? []).filter((stage) => stage.workflow === null).map(row),
  }));

  const lines: string[] = [];
  if (workflows.length > 0) {
    const heads = columns(workflows.map((w) => [w.name, `intake ${w.intake}`, at(w.file)]));
    const rows = columns(
      groups.flatMap((group) => [...group.private, ...group.shared]),
      6,
    );
    lines.push('', 'workflows');
    groups.forEach((group, i) => {
      lines.push(heads[i] ?? '');
      if (group.private.length > 0) lines.push('    private', ...rows.splice(0, group.private.length));
      if (group.shared.length > 0) lines.push('    shared', ...rows.splice(0, group.shared.length));
    });
  }
  const shared = stages.filter((stage) => stage.workflow === null);
  if (shared.length > 0) {
    const used = (stage: StageEntry) => {
      const users = workflows.filter((_, i) => reached[i]?.includes(stage)).map((w) => w.name);
      return users.length > 0 ? `used by ${users.join(', ')}` : 'unused';
    };
    lines.push('', 'shared stages', ...columns(shared.map((s) => [s.name, s.kind, used(s), at(s.file)])));
  }
  return lines.map((line) => `${line}\n`).join('');
}

/**
 * Rewrites the editor declarations of `sailDir` that are missing or stale, and says which, when a `tsconfig.json` there
 * shows the repository wants them. The check never reads that file: its presence is all it says. One that can't be
 * written is reported on stderr, and the check goes on.
 */
function refreshEditorDeclarations(sailDir: string, io: Io, at: (path: string) => string): void {
  if (!existsSync(join(sailDir, 'tsconfig.json'))) return;
  try {
    const written = writeEditorDeclarations(sailDir).map(at);
    if (written.length > 0) io.stdout(`sail check: wrote ${written.join(' and ')} for the editor\n`);
  } catch (error) {
    if (!(error instanceof EditorWriteError)) throw error;
    io.stderr(`sail check: could not write ${at(error.path)}: ${error.message}\n`);
  }
}

export async function check(args: Parsed, io: Io): Promise<ExitCode> {
  /** Every path the command prints goes through here, relative to where the user ran it. */
  const at = (path: string) => relative(io.cwd, path) || '.';

  const found = findSailDir(io.cwd);
  if ('refused' in found) {
    io.stderr(`sail check: ${found.refused}\n`);
    return EXIT_REFUSED;
  }
  const sail = `${at(found.dir)}/`;

  const config = readConfig(found.dir);
  if ('issues' in config) {
    const file = at(join(found.dir, 'project.yaml'));
    for (const issue of config.issues) io.stderr(`${formatIssue({ ...issue, file })}\n`);
    return EXIT_REFUSED;
  }

  // Before the type-check, so a stale declaration never reaches it.
  refreshEditorDeclarations(found.dir, io, at);
  const types = await typecheck(found.dir, io.tsc === undefined ? {} : { tsc: io.tsc });
  if ('internal' in types) {
    io.stderr(`sail check: could not run tsc\n${types.internal}\n`);
    return EXIT_INTERNAL;
  }
  if (!types.ok) {
    for (const diagnostic of types.diagnostics) io.stderr(`${formatDiagnostic(diagnostic, at)}\n`);
    const errors = types.diagnostics.filter((diagnostic) => diagnostic.code !== '').length;
    io.stderr(`sail check: ${count(errors, 'type error')} in ${sail}\n`);
    return EXIT_REFUSED;
  }

  const definitions = await loadDefinitions(found.dir);
  const imports = await importGraph(found.dir);
  if ('internal' in imports) {
    io.stderr(`sail check: could not read the import graph\n${imports.internal}\n`);
    return EXIT_INTERNAL;
  }
  const problems = [...definitions.problems, ...layoutProblems(found.dir, definitions, imports.graph)].sort(byFile);
  const { workflows, stages } = definitions;
  if (problems.length > 0) {
    for (const problem of problems) io.stderr(`${at(problem.file)}  ${problem.message}\n`);
    return EXIT_REFUSED;
  }

  // Last, as the one step that may reach a provider: a model alias whose harness can't run its model.
  const models = await checkModelAliases({
    sailDir: found.dir,
    config,
    builtins: BUILTINS,
    env: io.env ?? process.env,
  });
  if (models.length > 0) {
    const file = at(join(found.dir, 'project.yaml'));
    for (const issue of models) io.stderr(`${formatIssue({ ...issue, file })}\n`);
    return EXIT_REFUSED;
  }

  io.stdout(`${sail} checked: ${count(workflows.length, 'workflow')}, ${count(stages.length, 'stage')}\n`);
  if (args.values.list === true) io.stdout(listing(definitions, imports.graph, at));
  return EXIT_OK;
}

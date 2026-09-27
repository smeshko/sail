// Loads the one workflow a run starts from: its code, the stages it reaches, its intake, and every `.sail/` file it
// imports. A workflow is a function, so the stages it will call can't be known without running it. What it imports can
// be known before the run, so its roster is the stages its imports reach (ADR-0021).
import { existsSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import type { Intake, StageDefinition, Workflow } from '../sdk/index';
import * as intakes from '../sdk/intakes';
import { byFile, type Definitions, isStageDefinition, loadDefinitions } from './definitions';
import { type ImportGraph, importGraph } from './imports';
import { layoutProblems, reach } from './layout';

export interface ReachedStage {
  definition: StageDefinition;
  /** The absolute stage folder. */
  dir: string;
  /** The namespace of its `stage.ts`. */
  module: Record<string, unknown>;
}

export interface LoadedIntake {
  definition: Intake;
  /** The absolute private `intake.ts`, or the absolute shared `intakes/<name>/` folder. Absent for a built-in. */
  path?: string;
  /** The namespace that exports it: `sail/intakes` for a built-in. */
  module: Record<string, unknown>;
}

export interface LoadedWorkflow {
  name: string;
  workflow: Workflow;
  /** The absolute workflow folder. */
  dir: string;
  /** Every file under `.sail/` in the workflow's import graph, `workflow.ts` included, absolute and sorted. */
  files: string[];
  /**
   * The namespace of each file in `files`, by file. A file the workflow only imports types from may be missing: it
   * doesn't run, so it may throw when imported.
   */
  modules: ReadonlyMap<string, Record<string, unknown>>;
  /** Sorted by name. */
  stages: ReachedStage[];
  intake: LoadedIntake;
}

/** A workflow's name, as `project.yaml`'s `defaultWorkflow` takes it. It can't climb out of `workflows/`. */
const NAME = /^[a-z0-9][a-z0-9-]*$/;

/** `from` and every file it imports, transitively, sorted. */
function importedFrom(from: string, graph: ImportGraph): string[] {
  const files = new Set([from]);
  for (const file of files) for (const imported of graph.get(file) ?? []) files.add(imported);
  return [...files].sort();
}

/**
 * The workflow's intake: a built-in, compared by identity with `sail/intakes`' exports, or the one an `intake.ts` in
 * its import graph exports. Anything else is `undefined`.
 */
async function findIntake(
  intake: Intake,
  definitions: Definitions,
  files: ReadonlySet<string>,
): Promise<LoadedIntake | undefined> {
  const builtins: readonly unknown[] = Object.values(intakes);
  if (builtins.includes(intake)) return { definition: intake, module: { ...intakes } };
  for (const entry of definitions.intakes) {
    if (!files.has(entry.file)) continue;
    const module: Record<string, unknown> = await import(entry.file);
    if (!Object.values(module).includes(intake)) continue;
    // A private intake is its file, and a shared one is its folder, which may hold its scripts and prompts.
    return { definition: intake, path: entry.workflow === null ? dirname(entry.file) : entry.file, module };
  }
  return undefined;
}

/**
 * Imports `<sailDir>/workflows/<name>/workflow.ts` with the stages it reaches and its intake. It is refused when the
 * name isn't one, the file is missing, or any file in its import graph has a problem `sail check` would refuse: one
 * that won't import or holds the wrong definition, a private file of another workflow, or two reached stages of one
 * name. A problem elsewhere under `.sail/` doesn't refuse it. Reading the import graph failing is a crash, and throws.
 */
export async function loadWorkflow(sailDir: string, name: string): Promise<LoadedWorkflow | { refused: string }> {
  if (!NAME.test(name)) return { refused: `'${name}' is not a workflow name: lowercase letters, digits and dashes` };
  const at = (path: string) => relative(dirname(sailDir), path);
  const dir = join(sailDir, 'workflows', name);
  const file = join(dir, 'workflow.ts');
  if (!existsSync(file)) return { refused: `no workflow '${name}': ${at(file)} doesn't exist` };

  const definitions = await loadDefinitions(sailDir);
  const imports = await importGraph(sailDir);
  if ('internal' in imports) throw new Error(`could not read the import graph of ${sailDir}\n${imports.internal}`);
  const files = importedFrom(file, imports.graph);
  const inGraph = new Set(files);
  const problems = [...definitions.problems, ...layoutProblems(sailDir, definitions, imports.graph)]
    .filter((problem) => inGraph.has(problem.file))
    .sort(byFile);
  if (problems.length > 0) return { refused: problems.map((p) => `${at(p.file)}: ${p.message}`).join('\n') };

  // Every file here imported without a problem, so these imports return the modules Bun has cached: the stage objects
  // the workflow imported are the ones in their own modules' exports.
  const workflow: Workflow = (await import(file)).default;
  const stages: ReachedStage[] = [];
  for (const stage of reach({ file }, definitions, imports.graph)) {
    const module: Record<string, unknown> = await import(stage.file);
    const definition = Object.values(module).find(isStageDefinition) as StageDefinition;
    stages.push({ definition, dir: dirname(stage.file), module });
  }
  const intake = await findIntake(workflow.intake, definitions, inGraph);
  if (intake === undefined) {
    const why = 'is neither built in nor exported by an intake.ts it imports';
    return { refused: `${at(file)}: its intake '${workflow.intake.name}' ${why}` };
  }
  const modules = new Map<string, Record<string, unknown>>();
  for (const each of files) {
    try {
      modules.set(each, await import(each));
    } catch {
      // A file the workflow imports values from has imported already. This one only lends types, and never runs.
    }
  }
  return { name, workflow, dir, files, modules, stages, intake };
}

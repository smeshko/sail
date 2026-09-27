// The rules that span files under a `.sail/`: a private file stays inside its workflow's folder, and a workflow reaches
// each stage name once. Both read the import graph, so they hold for type-only imports too.
import { relative, sep } from 'node:path';
import {
  byFile,
  byName,
  type DefinitionProblem,
  type Definitions,
  type StageEntry,
  type WorkflowEntry,
} from './definitions';
import type { ImportGraph } from './imports';

/**
 * The stages a workflow's code reaches: those whose `stage.ts` its `workflow.ts` imports, directly or through helper
 * files. The walk stops at every `stage.ts` and `intake.ts`, since a definition's own imports add no stages.
 */
export function reach(
  workflow: Pick<WorkflowEntry, 'file'>,
  definitions: Definitions,
  graph: ImportGraph,
): StageEntry[] {
  const stages = new Map(definitions.stages.map((stage) => [stage.file, stage]));
  const intakes = new Set(definitions.intakes.map((intake) => intake.file));
  const reached: StageEntry[] = [];
  const visited = new Set([workflow.file]);
  const queue = [workflow.file];
  for (const file of queue) {
    for (const imported of graph.get(file) ?? []) {
      if (visited.has(imported)) continue;
      visited.add(imported);
      const stage = stages.get(imported);
      if (stage !== undefined) reached.push(stage);
      else if (!intakes.has(imported)) queue.push(imported);
    }
  }
  return reached.sort(byName);
}

/** The folder name of the workflow `file` is private to, or `null` when it's outside every workflow's folder. */
function owner(dir: string, file: string): string | null {
  const [top, folder, ...rest] = relative(dir, file).split(sep);
  return top === 'workflows' && folder !== undefined && rest.length > 0 ? folder : null;
}

/** Two or more items as `a and b`, or `a, b and c`. */
const listed = (items: readonly string[]) => `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`;

/**
 * Every import of a private file from outside its workflow's folder, as a problem on the importing file, and every
 * workflow reaching two stages of one name, as a problem on its `workflow.ts`. Paths in messages are relative to `dir`.
 */
export function layoutProblems(dir: string, definitions: Definitions, graph: ImportGraph): DefinitionProblem[] {
  const problems: DefinitionProblem[] = [];
  for (const [importer, files] of graph) {
    for (const file of files) {
      const workflow = owner(dir, file);
      if (workflow === null || workflow === owner(dir, importer)) continue;
      const message = `imports ${relative(dir, file)}, which is private to workflow ${workflow}`;
      problems.push({ file: importer, message });
    }
  }
  for (const workflow of definitions.workflows) {
    const named = Map.groupBy(reach(workflow, definitions, graph), (stage) => stage.name);
    for (const [name, stages] of named) {
      if (stages.length < 2) continue;
      const count = stages.length === 2 ? 'two' : String(stages.length);
      const files = listed(stages.map((stage) => relative(dir, stage.file)));
      problems.push({ file: workflow.file, message: `reaches ${count} stages named '${name}': ${files}` });
    }
  }
  return problems.sort(byFile);
}

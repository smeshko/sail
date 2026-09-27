// Loads a repository's `.sail/` definitions: imports each workflow and stage, and reads what the engine would run.
import { existsSync, readdirSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type { Intake, StageDefinition, Workflow } from '../sdk/index';
import * as sdk from '../sdk/index';
import * as intakes from '../sdk/intakes';

let registered = false;

/**
 * Registers `sail` and `sail/intakes` as Bun virtual modules backed by this process's `src/sdk`, so a repository's
 * `.sail/` imports them with no `node_modules` and shares one zod with the engine. A virtual module, because an
 * `onResolve` hook never runs for imports inside loaded files (Bun #40398). Idempotent, and never run on import: the
 * plugin is process-global. Epic 03 calls it before importing a workflow to run.
 */
export function registerSail(): void {
  if (registered) return;
  Bun.plugin({
    name: 'sail',
    setup(build) {
      build.module('sail', () => ({ exports: sdk, loader: 'object' }));
      build.module('sail/intakes', () => ({ exports: intakes, loader: 'object' }));
    },
  });
  registered = true;
}

export interface WorkflowEntry {
  name: string;
  intake: string;
  /** The folder's name under `workflows/`. */
  folder: string;
  file: string;
}

export interface StageEntry {
  name: string;
  kind: StageDefinition['kind'];
  /** A multi-step stage's steps, in order. Empty for a one-step agent or script. */
  steps: { name: string; kind: 'agent' | 'script' }[];
  /** The folder name of the workflow that owns it, or `null` when shared. */
  workflow: string | null;
  file: string;
}

export interface IntakeEntry {
  name: string;
  /** The folder name of the workflow that owns it, or `null` when shared. */
  workflow: string | null;
  file: string;
}

/** A file that can't load, or holds no definition. `file` is absolute. */
export interface DefinitionProblem {
  file: string;
  message: string;
}

export interface Definitions {
  workflows: WorkflowEntry[];
  intakes: IntakeEntry[];
  stages: StageEntry[];
  problems: DefinitionProblem[];
}

const STAGE_KINDS: readonly unknown[] = ['agent', 'script', 'stage'];

function kindOf(value: unknown): unknown {
  return typeof value === 'object' && value !== null ? (value as { kind?: unknown }).kind : undefined;
}

const isWorkflow = (value: unknown): value is Workflow => kindOf(value) === 'workflow';
const isIntake = (value: unknown): value is Intake => kindOf(value) === 'intake';
const isStageDefinition = (value: unknown): value is StageDefinition => STAGE_KINDS.includes(kindOf(value));

/** A stage's name as its folder gives it: the folder's name less a number prefix, so `10-spec` is `spec`. */
export function stageName(folder: string): string {
  return folder.replace(/^\d+-/, '');
}

/**
 * What is wrong with a `stage.ts`, the absolute `file`, that exports `definitions`, or `undefined` when nothing is: it
 * exports exactly one, named after its folder.
 */
export function stageFileProblem(file: string, definitions: readonly StageDefinition[]): string | undefined {
  const [definition, ...more] = definitions;
  if (definition === undefined) return 'exports no stage definition';
  if (more.length > 0) {
    const names = definitions.map((d) => d.name).join(', ');
    return `exports ${definitions.length} stage definitions (${names}), and a stage.ts exports exactly one`;
  }
  const folder = basename(dirname(file));
  if (definition.name !== stageName(folder)) {
    return `declares stage '${definition.name}', but its folder ${folder}/ says '${stageName(folder)}'`;
  }
  return undefined;
}

const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
/** By name, then file: two workflows may each own a stage of the same name. */
export const byName = <T extends { name: string; file: string }>(a: T, b: T) =>
  compare(a.name, b.name) || compare(a.file, b.file);
/** By file, then message: the order problems are printed in. */
export const byFile = (a: DefinitionProblem, b: DefinitionProblem) =>
  compare(a.file, b.file) || compare(a.message, b.message);

/**
 * Imports every definition under `dir`, a `.sail/`, and lists them by their own names, never their export names:
 * - `workflows/*\/workflow.ts`, which must default-export a workflow
 * - `workflows/*\/intake.ts` and `intakes/*\/intake.ts`, which must export an intake
 * - `workflows/*\/stages/*\/stage.ts` and `stages/*\/stage.ts`, which must export an agent, script or stage
 *
 * A definition under `workflows/<folder>/` is private to that workflow, and one elsewhere is shared. A workflow and a
 * stage are named after their folders, and a `stage.ts` or `intake.ts` exports exactly one definition. A
 * `workflows/*.ts` is refused without being imported: a workflow is a folder, and one without a `workflow.ts` is
 * refused too. A file with a problem adds no entry.
 */
export async function loadDefinitions(dir: string): Promise<Definitions> {
  registerSail();
  const found: Definitions = { workflows: [], intakes: [], stages: [], problems: [] };

  /** The files matching `pattern`, sorted, with the folder name of the workflow each sits under, or `null`. */
  const files = (pattern: string) =>
    [...new Bun.Glob(pattern).scanSync({ cwd: dir })].sort().map((path) => {
      const [top, folder = null] = path.split('/');
      return { file: join(dir, path), workflow: top === 'workflows' ? folder : null };
    });

  const load = async (
    pattern: string,
    read: (file: string, module: Record<string, unknown>, workflow: string | null) => void,
  ) => {
    for (const { file, workflow } of files(pattern)) {
      try {
        read(file, await import(file), workflow);
      } catch (error) {
        found.problems.push({ file, message: error instanceof Error ? error.message : String(error) });
      }
    }
  };

  for (const { file } of files('workflows/*.ts')) {
    const name = basename(file, '.ts');
    found.problems.push({ file, message: `a workflow is a folder: move this file to workflows/${name}/workflow.ts` });
  }
  const workflowsDir = join(dir, 'workflows');
  const folders = existsSync(workflowsDir) ? readdirSync(workflowsDir, { withFileTypes: true }) : [];
  for (const folder of folders.filter((entry) => entry.isDirectory())) {
    const file = join(workflowsDir, folder.name);
    if (!existsSync(join(file, 'workflow.ts'))) found.problems.push({ file, message: 'holds no workflow.ts' });
  }

  await load('workflows/*/workflow.ts', (file, module) => {
    const workflow = module.default;
    const folder = basename(dirname(file));
    if (!isWorkflow(workflow)) {
      found.problems.push({ file, message: 'default-exports no workflow' });
    } else if (workflow.name !== folder) {
      found.problems.push({ file, message: `declares workflow '${workflow.name}', but its folder is '${folder}'` });
    } else {
      found.workflows.push({ name: workflow.name, intake: workflow.intake.name, folder, file });
    }
  });

  const readIntakes = (file: string, module: Record<string, unknown>, workflow: string | null) => {
    const [intake, ...more] = new Set(Object.values(module).filter(isIntake));
    if (intake === undefined) {
      found.problems.push({ file, message: 'exports no intake' });
    } else if (more.length > 0) {
      const names = [intake, ...more].map((i) => i.name).join(', ');
      const message = `exports ${more.length + 1} intakes (${names}), and an intake.ts exports exactly one`;
      found.problems.push({ file, message });
    } else {
      found.intakes.push({ name: intake.name, workflow, file });
    }
  };
  await load('workflows/*/intake.ts', readIntakes);
  await load('intakes/*/intake.ts', readIntakes);

  const readStages = (file: string, module: Record<string, unknown>, workflow: string | null) => {
    const definitions = [...new Set(Object.values(module).filter(isStageDefinition))];
    const problem = stageFileProblem(file, definitions);
    if (problem !== undefined) {
      found.problems.push({ file, message: problem });
      return;
    }
    for (const definition of definitions) {
      const steps = definition.kind === 'stage' ? definition.steps.map(({ name, kind }) => ({ name, kind })) : [];
      found.stages.push({ name: definition.name, kind: definition.kind, steps, workflow, file });
    }
  };
  await load('workflows/*/stages/*/stage.ts', readStages);
  await load('stages/*/stage.ts', readStages);

  found.workflows.sort(byName);
  found.intakes.sort(byName);
  found.stages.sort(byName);
  found.problems.sort(byFile);
  return found;
}

/**
 * Imports one `stage.ts` and gives the stage definitions it exports, each once however many names it goes by. A throw
 * on import is a problem, carrying its message.
 */
export async function loadStageFile(file: string): Promise<{ definitions: StageDefinition[] } | { problem: string }> {
  registerSail();
  try {
    const module: Record<string, unknown> = await import(file);
    return { definitions: [...new Set(Object.values(module).filter(isStageDefinition))] };
  } catch (error) {
    return { problem: error instanceof Error ? error.message : String(error) };
  }
}

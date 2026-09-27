// Loads a repository's `.sail/` definitions: imports each workflow and stage, and reads what the engine would run.
import { join } from 'node:path';
import type { StageDefinition, Workflow } from '../sdk/index';
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
  file: string;
}

export interface StageEntry {
  name: string;
  kind: StageDefinition['kind'];
  /** A multi-step stage's steps, in order. Empty for a one-step agent or script. */
  steps: { name: string; kind: 'agent' | 'script' }[];
  file: string;
}

/** A file that can't load, or holds no definition. `file` is absolute. */
export interface DefinitionProblem {
  file: string;
  message: string;
}

export interface Definitions {
  workflows: WorkflowEntry[];
  stages: StageEntry[];
  problems: DefinitionProblem[];
}

const STAGE_KINDS: readonly unknown[] = ['agent', 'script', 'stage'];

function kindOf(value: unknown): unknown {
  return typeof value === 'object' && value !== null ? (value as { kind?: unknown }).kind : undefined;
}

const isWorkflow = (value: unknown): value is Workflow => kindOf(value) === 'workflow';
const isStageDefinition = (value: unknown): value is StageDefinition => STAGE_KINDS.includes(kindOf(value));

const byName = <T extends { name: string }>(a: T, b: T) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

/**
 * Imports every `workflows/*.ts` and `stages/*\/stage.ts` under `dir`, a `.sail/`, and lists the definitions by their
 * own names, never their export names. A workflow file must default-export a workflow, and a `stage.ts` must export at
 * least one agent, script or stage.
 */
export async function loadDefinitions(dir: string): Promise<Definitions> {
  registerSail();
  const found: Definitions = { workflows: [], stages: [], problems: [] };

  const load = async (pattern: string, read: (file: string, module: Record<string, unknown>) => void) => {
    const files = [...new Bun.Glob(pattern).scanSync({ cwd: dir })].sort().map((path) => join(dir, path));
    for (const file of files) {
      try {
        read(file, await import(file));
      } catch (error) {
        found.problems.push({ file, message: error instanceof Error ? error.message : String(error) });
      }
    }
  };

  await load('workflows/*.ts', (file, module) => {
    const workflow = module.default;
    if (!isWorkflow(workflow)) {
      found.problems.push({ file, message: 'default-exports no workflow' });
      return;
    }
    found.workflows.push({ name: workflow.name, intake: workflow.intake.name, file });
  });

  await load('stages/*/stage.ts', (file, module) => {
    const definitions = new Set(Object.values(module).filter(isStageDefinition));
    if (definitions.size === 0) found.problems.push({ file, message: 'exports no stage definition' });
    for (const definition of definitions) {
      const steps = definition.kind === 'stage' ? definition.steps.map(({ name, kind }) => ({ name, kind })) : [];
      found.stages.push({ name: definition.name, kind: definition.kind, steps, file });
    }
  });

  found.workflows.sort(byName);
  found.stages.sort(byName);
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

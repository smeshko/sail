// The roster: a run's intake and the stages its workflow reaches, each frozen with its origin as `sail.run.v1` shapes
// it. It records what the engine will use, not what was typed: a model alias is the model id it resolves to, exit codes
// carry their defaults, and a schema is the name its module exports it under. A header recording aliases and defaults
// as written would change meaning whenever `project.yaml` or sail's defaults change.
import { relative, sep } from 'node:path';
import { exitCodeMap } from '../kinds/script';
import type { Intake } from '../sdk/intake';
import type { Budget, Permissions, ScriptStep, StageDefinition, Step } from '../sdk/steps';
import type { ProjectConfig } from './config';
import type { LoadedWorkflow } from './load-workflow';

/** One step of a multi-step stage or intake. */
export interface StepRosterEntry {
  step: string;
  kind: 'agent' | 'script';
  model?: string;
  output?: string;
  produces?: string[];
  network?: readonly string[];
  permissions?: Permissions;
  budget?: Budget;
}

/** A stage: a one-step agent or script recorded flat, or a stage of several steps. */
export interface RosterEntry {
  kind?: 'agent' | 'script';
  origin: string;
  model?: string;
  output?: string;
  produces?: string[];
  network?: readonly string[];
  permissions?: Permissions;
  exitCodes?: { passed?: readonly number[]; failed?: readonly number[]; error?: readonly number[] };
  budget?: Budget;
  steps?: StepRosterEntry[];
}

export type IntakeEntry = RosterEntry & { name: string };

export interface Roster {
  intake: IntakeEntry;
  /** By stage name, sorted. */
  stages: Record<string, RosterEntry>;
}

/** `repo:` and the POSIX path of `path` relative to `base`, the directory holding `.sail/`. */
export function origin(base: string, path: string): string {
  return `repo:${relative(base, path).split(sep).join('/')}`;
}

/** Finds the name a schema is exported under. */
type Namer = (schema: unknown) => string | undefined;

/** The first name any of `modules` exports `schema` under, in order. */
function namer(modules: Iterable<Record<string, unknown>>): Namer {
  const searched = [...modules];
  return (schema) => {
    for (const module of searched) {
      for (const [name, value] of Object.entries(module)) if (value === schema) return name;
    }
    return undefined;
  };
}

/** `{ [key]: value }`, or nothing when `value` is undefined or an empty list: the header leaves those out. */
function field<K extends string, V>(key: K, value: V | undefined): { [P in K]?: V } {
  if (value === undefined || (Array.isArray(value) && value.length === 0)) return {};
  return { [key]: value } as { [P in K]: V };
}

/**
 * The agent steps of `definition` whose model alias `config.models` doesn't define, as one line each. `where` names the
 * definition, such as `stage 'spec'`.
 */
export function modelProblemsOf(where: string, definition: StageDefinition | Intake, config: ProjectConfig): string[] {
  const steps: readonly Step[] =
    definition.kind === 'agent' || definition.kind === 'script' ? [definition] : (definition.steps ?? []);
  return steps.flatMap((step) => {
    if (step.kind !== 'agent') return [];
    const at = steps.length > 1 ? `${where} step '${step.name}'` : where;
    const alias = step.model ?? 'default';
    if (Object.hasOwn(config.models, alias)) return [];
    return step.model === undefined
      ? [`${at} has an agent step with no model, and .sail/project.yaml's models defines no 'default'`]
      : [`${at} names the model alias '${alias}', which .sail/project.yaml's models doesn't define`];
  });
}

/**
 * The agent steps of `loaded` whose model alias `config.models` doesn't define, as one line each: the intake first, then
 * the stages by name.
 */
export function modelProblems(loaded: LoadedWorkflow, config: ProjectConfig): string[] {
  const { definition } = loaded.intake;
  const stages = [...loaded.stages].sort((a, b) => (a.definition.name < b.definition.name ? -1 : 1));
  return [
    ...modelProblemsOf(`intake '${definition.name}'`, definition, config),
    ...stages.flatMap((stage) => modelProblemsOf(`stage '${stage.definition.name}'`, stage.definition, config)),
  ];
}

/** A step's own fields, as a multi-step entry records them. `produces` may add files its stage or intake declares. */
function stepFields(
  step: Step,
  config: ProjectConfig,
  name: Namer,
  produces = Object.keys(step.produces),
): Omit<StepRosterEntry, 'step'> {
  const own = { ...field('output', name(step.output)), ...field('produces', produces) };
  if (step.kind === 'agent') {
    const model = config.models[step.model ?? 'default'];
    return { kind: 'agent', ...field('model', model), ...own, permissions: step.permissions, budget: step.budget };
  }
  const network = step.network === 'none' ? [] : step.network;
  return { kind: 'script', ...own, ...(network === undefined ? {} : { network }) };
}

/** A script's exit codes with sail's defaults applied. `error` has no default, so it is recorded only when declared. */
function exitCodes(step: ScriptStep): NonNullable<RosterEntry['exitCodes']> {
  const { passed, failed, error } = exitCodeMap(step);
  return { passed, failed, ...(step.exitCodes?.error === undefined ? {} : { error }) };
}

/** A step recorded flat, as a one-step agent or script, with its origin after its kind. */
function flat(step: Step, origin: string, config: ProjectConfig, name: Namer, produces?: string[]): RosterEntry {
  const { kind, ...fields } = stepFields(step, config, name, produces);
  return { kind, origin, ...fields, ...(step.kind === 'script' ? { exitCodes: exitCodes(step) } : {}) };
}

/**
 * A definition's entry. A stage or intake of one step is recorded flat, like that step, because `sail.run.v1` requires
 * at least two `steps`. An intake without steps records only its output and files.
 */
function entry(definition: StageDefinition | Intake, origin: string, config: ProjectConfig, name: Namer): RosterEntry {
  if (definition.kind === 'agent' || definition.kind === 'script') return flat(definition, origin, config, name);
  const produces = Object.keys(definition.produces);
  const [only, ...more] = definition.steps ?? [];
  if (only !== undefined && more.length === 0) {
    return flat(only, origin, config, name, [...new Set([...Object.keys(only.produces), ...produces])]);
  }
  const steps = (definition.steps ?? []).map((step) => ({ step: step.name, ...stepFields(step, config, name) }));
  return {
    origin,
    ...field('output', name(definition.output)),
    ...field('produces', produces),
    ...field('steps', steps),
  };
}

/**
 * The roster of `loaded`, with `base` the directory holding `.sail/`: one entry per stage the workflow reaches, keyed by
 * name, and the intake. A built-in intake's origin is `builtin`. A schema is named by the definition's own module first,
 * then by any module in the workflow's import graph, and its `output` is left out when none exports it.
 */
export function buildRoster(loaded: LoadedWorkflow, config: ProjectConfig, base: string): Roster {
  const graph = [...loaded.modules.values()];
  const stages = Object.fromEntries(
    loaded.stages.map((stage) => [
      stage.definition.name,
      entry(stage.definition, origin(base, stage.dir), config, namer([stage.module, ...graph])),
    ]),
  );
  const { definition, path, module } = loaded.intake;
  const intakeOrigin = path === undefined ? 'builtin' : origin(base, path);
  return {
    intake: { name: definition.name, ...entry(definition, intakeOrigin, config, namer([module, ...graph])) },
    stages,
  };
}

// Steps and stages: agent(), script() and stage() declare a contract and return a plain descriptor, whose `kind` the
// engine reads. A stage is one or more steps run in order. Its outcome is its last step's.

import type { z } from 'zod';
import type { Consumes, FileBinding, ValueBinding } from './bindings';

/** How a script step ended. The engine maps the exit code through `exitCodes`, and anything unmapped is `error`. */
export type ScriptOutcome = 'passed' | 'failed' | 'error';

/** How an agent step ended: what the agent declared, or `error`. Its judgments travel in the output. */
export type AgentOutcome = 'done' | 'blocked' | 'error';

/** What a step may do. Enforced for agents. For scripts, `network` is declared and recorded but not enforced. */
export interface Permissions {
  /** Globs of paths the step may read. */
  readonly read: readonly string[];
  /** Globs of paths the step may write. `$STAGE_OUT/**` covers the files it produces. */
  readonly write: readonly string[];
  /** Command patterns the step may run, such as `git diff *`. */
  readonly commands: readonly string[];
  /** The hosts the step may reach, or `'none'`. */
  readonly network?: 'none' | readonly string[];
}

/** The most one step may spend. Going over ends the step in `error`. */
export interface Budget {
  readonly maxTurns: number;
  readonly maxUsd: number;
  readonly maxMinutes: number;
}

/** The files a stage or step must leave in `$STAGE_OUT`, by name. */
export type Produces = Record<string, 'file'>;

/** Which exit codes mean `passed` and `failed`. The engine defaults to `{ passed: [0], failed: [1] }`. */
export interface ExitCodes {
  readonly passed?: readonly number[];
  readonly failed?: readonly number[];
  readonly error?: readonly number[];
}

/** What nothing consumed or produced looks like. It admits no keys, where `{}` would admit any. */
type None = Record<never, never>;

export interface AgentOptions<C extends Consumes, P extends Produces, O extends z.ZodType> {
  /** The step's instructions, relative to its stage directory. */
  readonly prompt: string;
  readonly consumes?: C;
  readonly produces?: P;
  /** The schema the agent submits its output against. */
  readonly output: O;
  /** A model alias from project.yaml's `models`. The engine defaults to `default`. */
  readonly model?: string;
  readonly permissions: Permissions;
  readonly budget: Budget;
  /** What an invalid output leads to. The engine defaults to `retry-once`, feeding the errors back. */
  readonly onInvalidOutput?: 'retry-once' | 'fail';
}

export interface ScriptOptions<C extends Consumes, P extends Produces, O extends z.ZodType> {
  /** The script to run, relative to its stage directory. Its last stdout line is the JSON output. */
  readonly run: string;
  readonly consumes?: C;
  readonly produces?: P;
  /** The schema the script's output is validated against. */
  readonly output: O;
  readonly exitCodes?: ExitCodes;
  readonly timeoutSeconds?: number;
  /** The hosts the script reaches. Declared and recorded, not enforced. */
  readonly network?: 'none' | readonly string[];
}

export interface StageOptions<C extends Consumes, P extends Produces, O extends z.ZodType, Steps extends StepList> {
  /** What the workflow supplies, including every binding the steps take from the workflow, under the same name. */
  readonly consumes?: C;
  readonly produces?: P;
  /** The stage's output schema: its last step's own, because the stage's output is its last step's. */
  readonly output: O;
  /** Run in order, sharing `$STAGE_OUT`. */
  readonly steps: Steps;
}

export interface AgentStep<
  C extends Consumes = Consumes,
  P extends Produces = Produces,
  O extends z.ZodType = z.ZodType,
> extends Omit<AgentOptions<C, P, O>, 'consumes' | 'produces'> {
  readonly kind: 'agent';
  readonly name: string;
  readonly consumes: C;
  readonly produces: P;
}

export interface ScriptStep<
  C extends Consumes = Consumes,
  P extends Produces = Produces,
  O extends z.ZodType = z.ZodType,
> extends Omit<ScriptOptions<C, P, O>, 'consumes' | 'produces'> {
  readonly kind: 'script';
  readonly name: string;
  readonly consumes: C;
  readonly produces: P;
}

export type Step = AgentStep | ScriptStep;

/** A stage's steps: at least one. */
export type StepList = readonly [Step, ...Step[]];

export interface Stage<
  C extends Consumes = Consumes,
  P extends Produces = Produces,
  O extends z.ZodType = z.ZodType,
  Steps extends StepList = StepList,
> extends Omit<StageOptions<C, P, O, Steps>, 'consumes' | 'produces'> {
  readonly kind: 'stage';
  readonly name: string;
  readonly consumes: C;
  readonly produces: P;
}

/** Anything `run.stage()` accepts: a one-step agent or script, or a stage of several steps. */
export type StageDefinition = AgentStep | ScriptStep | Stage;

/** The kind that decides a definition's outcomes. A stage's is its last step's. */
export type KindOf<S extends StageDefinition> = S extends Stage
  ? S['steps'] extends readonly [...Step[], infer Last extends Step]
    ? Last['kind']
    : never
  : S['kind'];

/** The outcomes a definition can end in, `error` included, as its result records them. */
export type OutcomeOf<S extends StageDefinition> = { agent: AgentOutcome; script: ScriptOutcome }[KindOf<S>];

/** Declares an agent step: the agent works to its prompt within its permissions and budget, then submits `output`. */
export function agent<C extends Consumes = None, P extends Produces = None, O extends z.ZodType = z.ZodType>(
  name: string,
  options: AgentOptions<C, P, O>,
): AgentStep<C, P, O> {
  return {
    kind: 'agent',
    name,
    ...options,
    consumes: options.consumes ?? ({} as C),
    produces: options.produces ?? ({} as P),
  };
}

/** Declares a script step: any executable, whose exit code decides `passed` or `failed`. */
export function script<C extends Consumes = None, P extends Produces = None, O extends z.ZodType = z.ZodType>(
  name: string,
  options: ScriptOptions<C, P, O>,
): ScriptStep<C, P, O> {
  return {
    kind: 'script',
    name,
    ...options,
    consumes: options.consumes ?? ({} as C),
    produces: options.produces ?? ({} as P),
  };
}

/** A stage's steps, whose last step's output fits the stage's `output`: the stage's output is its last step's. */
export type EndsIn<O extends z.ZodType> = readonly [...Step[], { readonly output: z.ZodType<z.infer<O>> }];

/**
 * Throws unless the last of `steps` declares `output` itself. `EndsIn` compares types, which can't see a schema's
 * refinements, so an equal-looking copy could still reject what the step emits.
 */
export function assertEndsIn(owner: string, steps: StepList, output: z.ZodType): void {
  const last = steps[steps.length - 1];
  if (last?.output !== output) {
    throw new Error(`${owner}: its output must be the schema its last step '${last?.name}' declares`);
  }
}

/**
 * The binding a stage declares for one that its step takes from the workflow: the same kind, a value the step's
 * accepts, and required when the step's is.
 */
type Covering<B> =
  B extends FileBinding<infer Opt>
    ? FileBinding<Opt extends false ? false : boolean>
    : B extends ValueBinding<infer S, infer Opt>
      ? ValueBinding<z.ZodType<z.infer<S>>, Opt extends false ? false : boolean>
      : never;

/** What one step takes from the workflow, by name. The engine resolves `gitDiff()` and `fromStep()` itself. */
type FromWorkflow<C extends Consumes> = {
  readonly [K in keyof C as C[K] extends FileBinding | ValueBinding ? K : never]: Covering<C[K]>;
};

/** Merges a union into an intersection, so what every step takes applies at once. */
type AllOf<U> = (U extends unknown ? (each: U) => void : never) extends (all: infer I) => void ? I : never;

/**
 * The workflow supplies a stage's bindings, never its steps', so a stage declares each binding its steps take from the
 * workflow, under the same name, as `Covering` describes.
 */
export type StepNeeds<Steps extends StepList> =
  AllOf<FromWorkflow<Steps[number]['consumes']>> extends infer Needs
    ? { readonly [K in keyof Needs]: Needs[K] }
    : never;

/** A stage's bindings: any its steps also take must fit what they take. */
export type FitsSteps<Steps extends StepList> = { readonly [K in keyof StepNeeds<Steps>]?: StepNeeds<Steps>[K] };

/**
 * The bindings a stage leaves out that its steps take, each required. Kept apart from `FitsSteps`, because intersecting
 * a declared binding with a mismatched one reduces it to `never`, which a diagnostic can't explain.
 */
export type CoversSteps<C extends Consumes, Steps extends StepList> = [
  Exclude<keyof StepNeeds<Steps>, keyof C>,
] extends [never]
  ? unknown
  : { readonly consumes: { readonly [K in Exclude<keyof StepNeeds<Steps>, keyof C>]: StepNeeds<Steps>[K] } };

/** Declares a stage of several steps, run in order. The workflow supplies `consumes` and gets `output` back. */
export function stage<
  C extends Consumes & FitsSteps<Steps> = None,
  P extends Produces = None,
  O extends z.ZodType = z.ZodType,
  const Steps extends StepList = StepList,
>(
  name: string,
  options: StageOptions<C, P, O, Steps> & { readonly steps: EndsIn<O> } & CoversSteps<C, Steps>,
): Stage<C, P, O, Steps> {
  assertEndsIn(`stage '${name}'`, options.steps, options.output);
  // The types check each binding the steps take from the workflow, except the refinements of a value's schema.
  const consumes: Consumes = options.consumes ?? {};
  for (const step of options.steps) {
    for (const [key, binding] of Object.entries(step.consumes)) {
      const own = consumes[key];
      if (binding.kind === 'value' && own?.kind === 'value' && own.schema !== binding.schema) {
        throw new Error(`stage '${name}': binding '${key}' must use the schema step '${step.name}' declares for it`);
      }
    }
  }
  return {
    kind: 'stage',
    name,
    ...options,
    consumes: options.consumes ?? ({} as C),
    produces: options.produces ?? ({} as P),
  };
}

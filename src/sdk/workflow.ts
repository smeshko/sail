// Workflows: composition only. workflow() names its intake, and its body routes on outcomes through the typed `run`.
// run.stage() checks the bindings against the stage's contract and returns a result that narrows by outcome, so a
// wrongly wired call is a compile error. At run time the engine supplies `run` (Epic 03).

import type { z } from 'zod';
import type { Consumes, FileBinding, ProducedFile, ValueBinding } from './bindings';
import type { Intake } from './intake';
import type { KindOf, Produces, Stage, StageDefinition, Step } from './steps';

declare const noBindings: unique symbol;

/** The value the workflow supplies for one binding: a produced file for `file()`, the schema's type for `value()`. */
type Supplied<B> = B extends FileBinding ? ProducedFile : B extends ValueBinding<infer S> ? z.infer<S> : never;

/** The bindings the workflow supplies. The engine resolves `gitDiff()` and `fromStep()` itself. */
type SuppliedKeys<C extends Consumes> = {
  [K in keyof C]: C[K] extends FileBinding | ValueBinding ? K : never;
}[keyof C];

type RequiredKeys<C extends Consumes> = {
  [K in SuppliedKeys<C>]: C[K]['isOptional'] extends false ? K : never;
}[SuppliedKeys<C>];

/** A stage the workflow supplies nothing to takes no bindings, or `{}`. It admits no key. */
export interface NoBindings {
  readonly [noBindings]?: never;
}

/** Merges an intersection into one object type, so a diagnostic prints the bindings as a single shape. */
type Flatten<T> = T extends infer U ? { [K in keyof U]: U[K] } : never;

/** What the workflow passes to `run.stage()` for a stage that consumes `C`. Optional bindings may be `undefined`. */
export type BindingsOf<C extends Consumes> = [SuppliedKeys<C>] extends [never]
  ? NoBindings
  : Flatten<
      { readonly [K in RequiredKeys<C>]: Supplied<C[K]> } & {
        readonly [K in Exclude<SuppliedKeys<C>, RequiredKeys<C>>]?: Supplied<C[K]> | undefined;
      }
    >;

/** `run.stage()`'s bindings argument, which may be left out when every binding is optional. */
type BindingsArgument<C extends Consumes> = [RequiredKeys<C>] extends [never]
  ? [bindings?: BindingsOf<C>]
  : [bindings: BindingsOf<C>];

/** The names of the files a call leaves: what the definition produces, and for a stage what each step produces. */
type FileNames<S extends StageDefinition> =
  | keyof S['produces']
  | (S extends Stage
      ? S['steps'][number] extends infer T
        ? T extends Step
          ? keyof T['produces']
          : never
        : never
      : never);

/** The files a call left, by name. */
export type ProducedFiles<F extends PropertyKey> = { readonly [K in F]: ProducedFile };

/** A script's result, or a stage's that ends in a script step: `passed` or `failed`, each with output and files. */
export interface ScriptResult<O, F extends PropertyKey> {
  readonly outcome: 'passed' | 'failed';
  readonly output: O;
  readonly files: ProducedFiles<F>;
}

/** An agent that finished: its output and files. */
export interface DoneResult<O, F extends PropertyKey> {
  readonly outcome: 'done';
  readonly output: O;
  readonly files: ProducedFiles<F>;
}

/** An agent that could not finish, and said why. It has no output to read. */
export interface BlockedResult {
  readonly outcome: 'blocked';
  readonly reason: string;
}

/** An agent's result, or a stage's that ends in an agent step. Rule out `blocked` before reading the output. */
export type AgentResult<O, F extends PropertyKey> = DoneResult<O, F> | BlockedResult;

/**
 * What `run.stage()` returns, by the kind of the definition's last step. `error` never reaches the workflow: by
 * default the engine fails the run on it.
 */
export type Result<S extends StageDefinition> =
  KindOf<S> extends 'script'
    ? ScriptResult<z.infer<S['output']>, FileNames<S>>
    : AgentResult<z.infer<S['output']>, FileNames<S>>;

/** One pass through a loop. `F` is what a failed pass carries into the next one. */
export interface Iteration<F = undefined> {
  /** What the previous pass failed with. `undefined` on the first pass. */
  readonly previous: F | undefined;
  /** Ends this pass as failed, carrying `feedback` into the next pass's `previous`. */
  fail(...feedback: [F] extends [undefined] ? [] : [feedback: F]): void;
}

export interface LoopOptions {
  /** The most passes the loop makes. */
  readonly max: number;
}

export interface Run<I extends z.ZodType = z.ZodType, P extends Produces = Produces> {
  /** The typed value the intake built. */
  readonly input: z.infer<I>;
  /** What the intake left: its files, by name. */
  readonly intake: { readonly files: ProducedFiles<keyof P> };
  /** Calls a stage with its bindings, and resolves to its result. */
  stage<S extends StageDefinition>(definition: S, ...bindings: BindingsArgument<S['consumes']>): Promise<Result<S>>;
  /** A bounded loop whose failed passes carry `feedback`, checked against its schema. */
  loop<F extends z.ZodType>(
    name: string,
    options: LoopOptions & { readonly feedback: F },
  ): Iterable<Iteration<z.infer<F>>>;
  /** A bounded loop whose passes carry nothing forward. */
  loop(name: string, options: LoopOptions): Iterable<Iteration>;
  /**
   * Fails the run with a reason. Write `return run.fail(…)`: TypeScript narrows on a call that never returns only
   * through an explicitly typed reference, and `run` is contextually typed, so a bare `run.fail(…);` statement leaves
   * the result it guards un-narrowed.
   */
  fail(reason: string): never;
}

/** A watch interval: a number of seconds, minutes or hours, such as `30s`, `5m` or `1h`. */
export type Duration = `${number}${'s' | 'm' | 'h'}`;

export interface Watch {
  readonly every: Duration;
  /** The designation label to poll for. The engine defaults to project.yaml's `label`. */
  readonly label?: string;
}

export interface WorkflowOptions<In extends Intake = Intake> {
  /** The intake that builds the run's input. */
  readonly intake: In;
  readonly version?: number;
  readonly description?: string;
  /** Watching: the watcher starts a run for each designated source. */
  readonly watch?: Watch;
  /** How many runs of a watched workflow may be in flight at once. */
  readonly maxConcurrentRuns?: number;
}

/**
 * A watched workflow declares both `watch` and `maxConcurrentRuns`, and an unwatched one neither. A union of the two
 * shapes would report a missing bound as a bad `every`, so the rule is checked against the options as written.
 */
export type WatchRule<O> = O extends { readonly watch: object }
  ? { readonly maxConcurrentRuns: number }
  : O extends { readonly maxConcurrentRuns: number }
    ? { readonly watch: Watch }
    : unknown;

/** Types each option `workflow()` doesn't know as `never`, so a misspelt `watch` is an error, not an unwatched workflow. */
export type KnownOptions<O> = { readonly [K in Exclude<keyof O, keyof WorkflowOptions>]: never };

export type WorkflowBody<In extends Intake, R> = (run: Run<In['output'], In['produces']>) => Promise<R>;

export interface Workflow<In extends Intake = Intake, R = unknown> extends WorkflowOptions<In> {
  readonly kind: 'workflow';
  readonly name: string;
  readonly fn: WorkflowBody<In, R>;
}

/** Declares a workflow: its intake, whether it is watched, and the body that composes stages. */
export function workflow<O extends WorkflowOptions, R>(
  name: string,
  options: O & WatchRule<O> & KnownOptions<O>,
  fn: WorkflowBody<O['intake'], R>,
): Workflow<O['intake'], R> {
  return { kind: 'workflow', name, ...options, fn };
}

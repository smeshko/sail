// Generated from src/sdk by `bun run types`. Do not edit.
import type { z } from 'zod';
import type { Consumes, FileBinding, FromStepBinding, ValueBinding } from './bindings';
import type { Document } from './documents';
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
    /**
     * Command patterns the step may never run, though `commands` matches them: `commands: ['*']` with
     * `deny: ['git push *']` runs anything but a push. Matched like `commands`, on every command a call would run.
     */
    readonly deny?: readonly string[];
    /** The hosts the step may reach, or `'none'`. */
    readonly network?: 'none' | readonly string[];
    /**
     * The tools and MCP servers the step may reach, by name: a tool (`WebFetch`), a server's tool (`linear:get_issue`)
     * or every tool of a server (`github:*`). Anything not listed is denied, and absent lists none. Reads, writes and
     * commands are governed by their own lists.
     */
    readonly tools?: readonly string[];
}
/** The most one step may spend. Going over ends the step in `error`. */
export interface Budget {
    readonly maxTurns: number;
    readonly maxUsd: number;
    readonly maxMinutes: number;
}
/** The files a stage or step must leave in `$STAGE_OUT`, by name. */
export type Produces = Record<string, 'file'>;
/** The files an agent step must leave in `$STAGE_OUT`, by name: any may be a document, which the agent completes. */
export type AgentProduces = Record<string, 'file' | Document>;
/** Which exit codes mean `passed` and `failed`. The engine defaults to `{ passed: [0], failed: [1] }`. */
export interface ExitCodes {
    readonly passed?: readonly number[];
    readonly failed?: readonly number[];
    readonly error?: readonly number[];
}
/** What nothing consumed or produced looks like. It admits no keys, where `{}` would admit any. */
type None = Record<never, never>;
export interface AgentOptions<C extends Consumes, P extends AgentProduces, O extends z.ZodType> {
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
    /**
     * The convention files appended to this step's prompt, each a path inside the repository, in place of project.yaml's
     * `conventions`: `[]` appends none. It may name any file in the repository, the project's or not, under the same rule
     * as project.yaml's list: a regular file inside the repository, or the call doesn't start. Left out, the step gets
     * the project's.
     */
    readonly conventions?: readonly string[];
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
    /**
     * Extra environment names passed when set, credentials included; for example `env: ['JAVA_HOME']`.
     * Defaults are non-credential allowlisted names, SSH_AUTH_SOCK, SAIL_* knobs, git identity and the preamble.
     * script:exec records declared names, never their values.
     */
    readonly env?: readonly string[];
    /**
     * How long the script may run. The engine defaults to 600, and on a timeout stops the script's whole process group:
     * SIGTERM, then SIGKILL after a grace period.
     */
    readonly timeoutSeconds?: number;
    /**
     * The name of a machine-wide exclusive slot: one step on the machine holds a name at a time, whichever run it belongs
     * to. A step that finds it held waits, and its run's events say who holds it. A slot is freed once its holder's
     * process is dead. Waiting doesn't count toward `timeoutSeconds`. A name is lowercase letters, digits and hyphens.
     */
    readonly exclusive?: string;
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
export interface AgentStep<C extends Consumes = Consumes, P extends AgentProduces = AgentProduces, O extends z.ZodType = z.ZodType, N extends string = string> extends Omit<AgentOptions<C, P, O>, 'consumes' | 'produces'> {
    readonly kind: 'agent';
    /** The step's name, as its literal type: a later step's `fromStep()` names it. */
    readonly name: N;
    readonly consumes: C;
    readonly produces: P;
}
export interface ScriptStep<C extends Consumes = Consumes, P extends Produces = Produces, O extends z.ZodType = z.ZodType, N extends string = string> extends Omit<ScriptOptions<C, P, O>, 'consumes' | 'produces'> {
    readonly kind: 'script';
    /** The step's name, as its literal type: a later step's `fromStep()` names it. */
    readonly name: N;
    readonly consumes: C;
    readonly produces: P;
}
export type Step = AgentStep | ScriptStep;
/** A stage's steps: at least one. */
export type StepList = readonly [Step, ...Step[]];
export interface Stage<C extends Consumes = Consumes, P extends Produces = Produces, O extends z.ZodType = z.ZodType, Steps extends StepList = StepList> extends Omit<StageOptions<C, P, O, Steps>, 'consumes' | 'produces'> {
    readonly kind: 'stage';
    readonly name: string;
    readonly consumes: C;
    readonly produces: P;
}
/** Anything `run.stage()` accepts: a one-step agent or script, or a stage of several steps. */
export type StageDefinition = AgentStep | ScriptStep | Stage;
/** The kind that decides a definition's outcomes. A stage's is its last step's. */
export type KindOf<S extends StageDefinition> = S extends Stage ? S['steps'] extends readonly [...Step[], infer Last extends Step] ? Last['kind'] : never : S['kind'];
/** The steps of a stage before its last one: those that can stop it early. */
export type EarlierSteps<S extends StageDefinition> = S extends Stage ? S['steps'] extends readonly [...infer Earlier extends readonly Step[], Step] ? Earlier[number] : never : never;
/** What an earlier step can end its stage in: `blocked` for an agent step, `failed` for a script step. */
type StopsWith<E> = E extends {
    readonly kind: 'agent';
} ? 'blocked' : E extends {
    readonly kind: 'script';
} ? 'failed' : never;
/**
 * The outcomes a definition can end in, `error` included, as its result records them: its last step's, and for a
 * stage what an earlier step can end it in, since a step that doesn't pass ends its stage.
 */
export type OutcomeOf<S extends StageDefinition> = {
    agent: AgentOutcome;
    script: ScriptOutcome;
}[KindOf<S>] | StopsWith<EarlierSteps<S>>;
/** Declares an agent step: the agent works to its prompt within its permissions and budget, then submits `output`. */
export declare function agent<const N extends string, C extends Consumes = None, P extends AgentProduces = None, O extends z.ZodType = z.ZodType>(name: N, options: AgentOptions<C, P, O>): AgentStep<C, P, O, N>;
/** Declares a script step: any executable, whose exit code decides `passed` or `failed`. */
export declare function script<const N extends string, C extends Consumes = None, P extends Produces = None, O extends z.ZodType = z.ZodType>(name: N, options: ScriptOptions<C, P, O>): ScriptStep<C, P, O, N>;
/** A stage's steps, whose last step's output fits the stage's `output`: the stage's output is its last step's. */
export type EndsIn<O extends z.ZodType> = readonly [...Step[], {
    readonly output: z.ZodType<z.infer<O>>;
}];
/**
 * Throws unless the last of `steps` declares `output` itself. `EndsIn` compares types, which can't see a schema's
 * refinements, so an equal-looking copy could still reject what the step emits.
 */
export declare function assertEndsIn(owner: string, steps: StepList, output: z.ZodType): void;
/**
 * The binding a stage declares for one that its step takes from the workflow: the same kind, a value the step's
 * accepts, and required when the step's is.
 */
type Covering<B> = B extends FileBinding<infer Opt> ? FileBinding<Opt extends false ? false : boolean> : B extends ValueBinding<infer S, infer Opt> ? ValueBinding<z.ZodType<z.infer<S>>, Opt extends false ? false : boolean> : never;
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
export type StepNeeds<Steps extends StepList> = AllOf<FromWorkflow<Steps[number]['consumes']>> extends infer Needs ? {
    readonly [K in keyof Needs]: Needs[K];
} : never;
/** A stage's bindings: any its steps also take must fit what they take. */
export type FitsSteps<Steps extends StepList> = {
    readonly [K in keyof StepNeeds<Steps>]?: StepNeeds<Steps>[K];
};
/**
 * The bindings a stage leaves out that its steps take, each required. Kept apart from `FitsSteps`, because intersecting
 * a declared binding with a mismatched one reduces it to `never`, which a diagnostic can't explain.
 */
export type CoversSteps<C extends Consumes, Steps extends StepList> = [
    Exclude<keyof StepNeeds<Steps>, keyof C>
] extends [never] ? unknown : {
    readonly consumes: {
        readonly [K in Exclude<keyof StepNeeds<Steps>, keyof C>]: StepNeeds<Steps>[K];
    };
};
/** The steps the `fromStep()` bindings of `C` name. */
type NamedSteps<C extends Consumes> = {
    [K in keyof C]: C[K] extends FromStepBinding<infer N> ? N : never;
}[keyof C];
/**
 * A step, unless a `fromStep()` binding of its names a step outside `Seen`, the steps before it. Each such binding is
 * then required to name one of them, so the diagnostic points at the binding.
 */
type InPlace<S extends Step, Seen extends string> = [Exclude<NamedSteps<S['consumes']>, Seen>] extends [never] ? S : S & {
    readonly consumes: {
        readonly [K in keyof S['consumes'] as S['consumes'][K] extends FromStepBinding<infer N> ? N extends Seen ? never : K : never]: FromStepBinding<Seen>;
    };
};
/**
 * A stage's steps, each checked against the names of the steps before it: a `fromStep()` may name only an earlier
 * step, never a later one, itself or one the stage doesn't have.
 */
export type InOrder<Steps extends readonly Step[], Seen extends string = never> = Steps extends readonly [
    infer First extends Step,
    ...infer Rest extends readonly Step[]
] ? readonly [InPlace<First, Seen>, ...InOrder<Rest, Seen | First['name']>] : readonly [];
/** Declares a stage of several steps, run in order. The workflow supplies `consumes` and gets `output` back. */
export declare function stage<C extends Consumes & FitsSteps<Steps> = None, P extends Produces = None, O extends z.ZodType = z.ZodType, const Steps extends StepList = StepList>(name: string, options: StageOptions<C, P, O, Steps> & {
    readonly steps: EndsIn<O> & InOrder<Steps>;
} & CoversSteps<C, Steps>): Stage<C, P, O, Steps>;
export {};
